#!/usr/bin/env ts-node
import * as fs from 'fs';
import * as path from 'path';
import { program } from 'commander';
import * as anchor from '@project-serum/anchor';
import fetch from 'node-fetch';
import {
  chunks,
  fromUTF8Array,
  generateRandomSet,
  getPriceWithMantissa,
  parseDate,
  parsePrice,
  sleep,
} from './helpers/various';
import { AccountInfo, Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  CACHE_PATH,
  CONFIG_ARRAY_START,
  CONFIG_LINE_SIZE,
  EXTENSION_JSON,
  EXTENSION_PNG,
  CANDY_MACHINE_PROGRAM_ID,
  ARWEAVE_PAYMENT_WALLET,
  WRAPPED_SOL_MINT,
  TOKEN_ENTANGLEMENT_PROGRAM_ID,
} from './helpers/constants';
import {
  getBalance,
  getCandyMachineAddress,
  getProgramAccounts,
  loadCandyProgram,
  loadWalletKey,
  AccountAndPubkey,
  deserializeAccount,
  getAtaForMint,
  loadTokenEntanglementProgream,
  getMasterEdition,
  getMetadata,
  getTokenEntanglement,
  getTokenEntanglementEscrows,
  getCandyMachineCreator,
} from './helpers/accounts';
import { Config } from './types';
import { verifyTokenMetadata } from './commands/verifyTokenMetadata';
import { generateConfigurations } from './commands/generateConfigurations';
import { loadCache, saveCache } from './helpers/cache';
import { mint } from './commands/mint';
import { signMetadata } from './commands/sign';
import {
  getAccountsByCreatorAddress,
  signAllMetadataFromCandyMachine,
} from './commands/signAll';
import log from 'loglevel';
import { createMetadataFiles } from './helpers/metadata';
import { createGenerativeArt } from './commands/createArt';
import { withdraw } from './commands/withdraw';
import { updateFromCache } from './commands/updateFromCache';
import _ from 'lodash';
import { getMultipleAccounts } from '@project-serum/anchor/dist/cjs/utils/rpc';
import {
  Creator,
  Data,
  decodeMetadata,
  METADATA_SCHEMA,
  UpdateMetadataArgs,
} from './helpers/schema';
import { serialize } from 'borsh';
import {
  createAssociatedTokenAccountInstruction,
  createUpdateMetadataInstruction,
} from './helpers/instructions';

import FormData from 'form-data';
import { stat } from 'fs/promises';
import { calculate } from '@metaplex/arweave-cost';
import { sendTransactionWithRetryWithKeypair } from './helpers/transactions';

program.version('0.0.2');

if (!fs.existsSync(CACHE_PATH)) {
  fs.mkdirSync(CACHE_PATH);
}

const TIERS = {
  1: {
    HEAD: {
      'Rudolph Headband': 30,
      'Xmas Lights': 30,
      'Xmas Crown': 20,
      'Santa Hat': 10,
      Original: 10,
    },
    BODY: {
      'Santa Jacket': 30,
      'Elf Jacket': 70,
      Original: 0,
    },
  },
  2: {
    HEAD: {
      'Rudolph Headband': 20,
      'Xmas Lights': 20,
      'Xmas Crown': 20,
      'Santa Hat': 10,
      Original: 30,
    },
    BODY: {
      'Santa Jacket': 20,
      'Elf Jacket': 60,
      Original: 20,
    },
  },
  3: {
    HEAD: {
      'Rudolph Headband': 20,
      'Xmas Lights': 20,
      'Xmas Crown': 15,
      'Santa Hat': 5,
      Original: 40,
    },
    BODY: {
      'Santa Jacket': 20,
      'Elf Jacket': 50,
      Original: 30,
    },
  },

  4: {
    HEAD: {
      'Rudolph Headband': 20,
      'Xmas Lights': 20,
      'Xmas Crown': 0,
      'Santa Hat': 0,
      Original: 60,
    },
    BODY: {
      'Santa Jacket': 10,
      'Elf Jacket': 40,
      Original: 50,
    },
  },

  5: {
    HEAD: {
      'Rudolph Headband': 10,
      'Xmas Lights': 10,
      'Xmas Crown': 0,
      'Santa Hat': 0,
      Original: 80,
    },
    BODY: {
      'Santa Jacket': 10,
      'Elf Jacket': 30,
      Original: 60,
    },
  },

  6: {
    HEAD: {
      'Rudolph Headband': 5,
      'Xmas Lights': 5,
      'Xmas Crown': 0,
      'Santa Hat': 0,
      Original: 90,
    },
    BODY: {
      'Santa Jacket': 5,
      'Elf Jacket': 15,
      Original: 80,
    },
  },
};

log.setLevel(log.levels.INFO);
const ARWEAVE_UPLOAD_ENDPOINT =
  'https://us-central1-metaplex-studios.cloudfunctions.net/uploadFile';

async function fetchAssetCostToStore(fileSizes: number[]) {
  const result = await calculate(fileSizes);
  log.debug('Arweave cost estimates:', result);

  return result.solana * anchor.web3.LAMPORTS_PER_SOL;
}

async function upload(data: FormData) {
  return await (
    await fetch(ARWEAVE_UPLOAD_ENDPOINT, {
      method: 'POST',
      // @ts-ignore
      body: data,
    })
  ).json();
}

function estimateManifestSize(filenames: string[]) {
  const paths = {};

  for (const name of filenames) {
    paths[name] = {
      id: 'artestaC_testsEaEmAGFtestEGtestmMGmgMGAV438',
      ext: path.extname(name).replace('.', ''),
    };
  }

  const manifest = {
    manifest: 'arweave/paths',
    version: '0.1.0',
    paths,
    index: {
      path: 'metadata.json',
    },
  };

  const data = Buffer.from(JSON.stringify(manifest), 'utf8');
  log.debug('Estimated manifest size:', data.length);
  return data.length;
}

export async function arweaveUpload(
  walletKeyPair,
  anchorProgram,
  env,
  manifestBuffer, // TODO rename metadataBuffer
) {
  const estimatedManifestSize = estimateManifestSize([
    'image.png',
    'metadata.json',
  ]);
  const storageCost = await fetchAssetCostToStore([
    0,
    manifestBuffer.length,
    estimatedManifestSize,
  ]);

  const instructions = [
    anchor.web3.SystemProgram.transfer({
      fromPubkey: walletKeyPair.publicKey,
      toPubkey: ARWEAVE_PAYMENT_WALLET,
      lamports: storageCost,
    }),
  ];

  const tx = await sendTransactionWithRetryWithKeypair(
    anchorProgram.provider.connection,
    walletKeyPair,
    instructions,
    [],
    'confirmed',
  );
  log.debug(`solana transaction (${env}) for arweave payment:`, tx);

  const data = new FormData();
  data.append('transaction', tx['txid']);
  data.append('env', env);
  data.append('file[]', manifestBuffer, 'metadata.json');

  const result = await upload(data);

  const metadataFile = result.messages?.find(
    m => m.filename === 'manifest.json',
  );
  if (metadataFile?.transactionId) {
    const link = `https://arweave.net/${metadataFile.transactionId}`;
    log.debug(`File uploaded: ${link}`);
    return link;
  } else {
    // @todo improve
    throw new Error(`No transaction ID for upload`);
  }
}

programCommand('update_levels_on_chain')
  .option(
    '-r, --rpc-url <string>',
    'custom rpc url since this is a heavy command',
  )
  .action(async (files: string[], cmd) => {
    const { keypair, env, rpcUrl, start } = cmd.opts();
    const walletKeyPair = loadWalletKey(keypair);
    const anchorProgram = await loadCandyProgram(walletKeyPair, env, rpcUrl);
    let toUpdate = fs.readdirSync('replacements/');
    await Promise.all(
      chunks(Array.from(Array(toUpdate.length).keys()), 1000).map(
        async allIndexesInSlice => {
          for (let i = 0; i < allIndexesInSlice.length; i += 100) {
            const indexes = allIndexesInSlice
              .slice(i, i + 100)
              .reduce((hash, el) => {
                hash[toUpdate[el]] = true;
                return hash;
              }, {});
            const metadataAddresses = toUpdate.filter(k => indexes[k]);
            const metadataAccounts = await getMultipleAccounts(
              anchorProgram.provider.connection,
              metadataAddresses.map(
                a => new anchor.web3.PublicKey(a.split('.')[0]),
              ),
            );
            for (let j = 0; j < metadataAccounts.length; j++) {
              const metadata = decodeMetadata(metadataAccounts[j].account.data);
              try {
                const newJSON = fs.readFileSync(
                  'replacements/' + metadataAccounts[j].publicKey + '.json',
                );
                const parsedJ = JSON.parse(newJSON.toString());
                const existing = parsedJ.attributes.find(
                  a => a.trait_type == '❤️',
                );
                const uriData = await fetch(metadata.data.uri);

                const body = await uriData.text();
                const parsed = JSON.parse(body);
                let existingAttr = parsed.attributes.find(
                  a => a.trait_type == '❤️',
                );
                if (
                  !existing ||
                  !existingAttr ||
                  existing.value != existingAttr.value
                ) {
                  const newLink = await arweaveUpload(
                    walletKeyPair,
                    anchorProgram,
                    env,
                    newJSON, // TODO rename metadataBuffer
                  );
                  const newData = new Data({
                    ...metadata.data,
                    creators: metadata.data.creators.map(
                      c =>
                        new Creator({
                          ...c,
                          address: new anchor.web3.PublicKey(
                            c.address,
                          ).toBase58(),
                        }),
                    ),
                    uri: newLink,
                  });

                  const value = new UpdateMetadataArgs({
                    data: newData,
                    updateAuthority: walletKeyPair.publicKey.toBase58(),
                    primarySaleHappened: null,
                  });
                  const txnData = Buffer.from(
                    serialize(METADATA_SCHEMA, value),
                  );
                  console.log(
                    'Writing to update',
                    metadataAccounts[j].publicKey.toBase58(),
                  );

                  await sendTransactionWithRetryWithKeypair(
                    anchorProgram.provider.connection,
                    walletKeyPair,
                    [
                      createUpdateMetadataInstruction(
                        metadataAccounts[j].publicKey,
                        walletKeyPair.publicKey,
                        txnData,
                      ),
                    ],
                    [],
                    'single',
                  );
                } else {
                  console.log(
                    'Skipping, already done',
                    metadataAccounts[j].publicKey.toBase58(),
                  );
                }
              } catch (e) {
                console.error(e);
                console.log('done');
              }
            }
          }
          return true;
        },
      ),
    );
  });
programCommand('update_levels')
  .option(
    '-r, --rpc-url <string>',
    'custom rpc url since this is a heavy command',
  )
  .action(async (files: string[], cmd) => {
    const { keypair, env, rpcUrl, start } = cmd.opts();
    const currentAgesText = fs.readFileSync('current-ages.json');

    const parsedAges = JSON.parse(currentAgesText.toString());
    console.log('Including falses', Object.values(parsedAges).length);
    const ageSet = Object.values(parsedAges).filter(f => f);
    const walletKeyPair = loadWalletKey(keypair);
    const anchorProgram = await loadCandyProgram(walletKeyPair, env, rpcUrl);
    console.log('Total size is', ageSet.length);
    const sorted: number[] = ageSet.sort(
      (a, b) => (a as number) - (b as number),
    ) as number[];
    const levels = 6;
    const levelMeter = [];
    for (let i = 0; i < levels; i++) {
      levelMeter.push(
        sorted[Math.round(((i + 1) * ageSet.length) / levels) - 1],
      );
    }
    console.log('Level limits', levelMeter);

    const beforekeys = Object.keys(parsedAges);
    const keys = [];
    for (let i = 0; i < beforekeys.length; i++) {
      if (!fs.existsSync('replacements/' + beforekeys[i] + '.json')) {
        keys.push(beforekeys[i]);
      }
    }
    console.log('Keys to do', keys.length);
    await Promise.all(
      chunks(Array.from(Array(keys.length).keys()), 1000).map(
        async allIndexesInSlice => {
          for (let i = 0; i < allIndexesInSlice.length; i += 100) {
            const indexes = allIndexesInSlice
              .slice(i, i + 100)
              .reduce((hash, el) => {
                hash[keys[el]] = true;
                return hash;
              }, {});
            const metadataAddresses = keys.filter(k => indexes[k]);
            const metadataAccounts = await getMultipleAccounts(
              anchorProgram.provider.connection,
              metadataAddresses.map(a => new anchor.web3.PublicKey(a)),
            );
            for (let j = 0; j < metadataAccounts.length; j++) {
              const metadata = decodeMetadata(metadataAccounts[j].account.data);
              const uriData = await fetch(metadata.data.uri);

              const body = await uriData.text();
              const parsed = JSON.parse(body);
              let existingAttr = parsed.attributes.find(
                a => a.trait_type == '❤️',
              );
              if (!existingAttr)
                parsed.attributes.push({ trait_type: '❤️', value: 0 });
              existingAttr = parsed.attributes.find(a => a.trait_type == '❤️');
              let myLevel = levels; // max default
              const val = parsedAges[metadataAccounts[j].publicKey.toBase58()];
              if (val) {
                for (let k = 0; k < levelMeter.length; k++) {
                  const currLevel = levelMeter[k];
                  if (currLevel > val) {
                    myLevel = k + 1;
                    break;
                  }
                }
              }

              existingAttr.value = myLevel;
              console.log('Writing', metadataAccounts[j].publicKey.toBase58());
              fs.writeFileSync(
                'replacements/' +
                  metadataAccounts[j].publicKey.toBase58() +
                  '.json',
                JSON.stringify(parsed),
              );
            }
          }
        },
      ),
    );
  });

programCommand('pull_chain_data')
  .option(
    '-r, --rpc-url <string>',
    'custom rpc url since this is a heavy command',
  )
  .action(async (files: string[], cmd) => {
    const { keypair, env, rpcUrl, start } = cmd.opts();
    const walletKeyPair = loadWalletKey(keypair);
    const anchorProgram = await loadCandyProgram(walletKeyPair, env, rpcUrl);
    const candyMachine = 'CLErvyrMpi66RAxNV2wveSi25NxHb8G383MSVuGDgZzp';
    const currentAgesText = fs.readFileSync('current-ages.json');
    const parsedAges = JSON.parse(currentAgesText.toString());
    console.log('Updated');
    const metadataByCandyMachine = [
      ...(await getAccountsByCreatorAddress(
        candyMachine,
        anchorProgram.provider.connection,
      )),
      ...(await getAccountsByCreatorAddress(
        'HHGsTSzwPpYMYDGgUqssgAsMZMsYbshgrhMge8Ypgsjx',
        anchorProgram.provider.connection,
      )),
    ];

    const hash = parsedAges;
    const keysNotPresent = _.difference(
      metadataByCandyMachine.map(m => m[1]),
      Object.keys(parsedAges),
    );
    await Promise.all(
      chunks(Array.from(Array(keysNotPresent.length).keys()), 1000).map(
        async allIndexesInSlice => {
          for (let i = 0; i < allIndexesInSlice.length; i++) {
            const metadata = metadataByCandyMachine.find(
              m => m[1] == keysNotPresent[allIndexesInSlice[i]],
            );
            const mint = new anchor.web3.PublicKey(metadata[0].mint);
            const currentAccounts =
              await anchorProgram.provider.connection.getTokenLargestAccounts(
                mint,
              );
            const holding = currentAccounts.value.find(a => a.amount == '1');

            console.log('Found holding address', holding.address.toBase58());
            const sigs =
              await anchorProgram.provider.connection.getConfirmedSignaturesForAddress2(
                holding.address,
              );
            const txns =
              await anchorProgram.provider.connection.getParsedConfirmedTransactions(
                sigs.map(s => s.signature),
              );
            const txnSorted = txns.sort((a, b) => b.blockTime - a.blockTime);
            const myAcctIndex =
              txnSorted[0].transaction.message.accountKeys.findIndex(a =>
                a.pubkey.equals(holding.address),
              );

            const mostRecentEntry =
              txnSorted.find(
                t =>
                  t.meta.postTokenBalances.find(
                    tb =>
                      tb.mint == mint.toBase58() &&
                      tb.accountIndex == myAcctIndex,
                  )?.uiTokenAmount?.uiAmount == 1 &&
                  t.meta.preTokenBalances.find(
                    tb =>
                      tb.mint == mint.toBase58() &&
                      tb.accountIndex != myAcctIndex,
                  )?.uiTokenAmount?.uiAmount == 1,
              ) ||
              txnSorted.find(
                t =>
                  t.meta.postTokenBalances.find(
                    tb =>
                      tb.mint == mint.toBase58() &&
                      tb.accountIndex == myAcctIndex,
                  )?.uiTokenAmount?.uiAmount == 1,
              );

            const mostRecentLoss = txnSorted.find(t =>
              t.meta.innerInstructions.find(i =>
                i.instructions.find(x => {
                  return (
                    //@ts-ignore
                    x.program == 'spl-token' &&
                    //@ts-ignore
                    x.parsed.type == 'approve' &&
                    //@ts-ignore
                    x.parsed.info.source == holding.address.toBase58()
                  );
                }),
              ),
            );
            if (!mostRecentLoss && mostRecentEntry) {
              hash[metadata[1]] = mostRecentEntry.blockTime;
            } else if (mostRecentEntry && mostRecentEntry) {
              hash[metadata[1]] = false;
            }

            if (i % 10 == 0) {
              fs.writeFileSync('current-ages.json', JSON.stringify(hash));
            }
          }
        },
      ),
    );
    console.log('Done');
    fs.writeFileSync('current-ages.json', JSON.stringify(hash));
  });

programCommand('all_mints')
  .option(
    '-r, --rpc-url <string>',
    'custom rpc url since this is a heavy command',
  )
  .action(async (files: string[], cmd) => {
    const { keypair, env, rpcUrl, start } = cmd.opts();
    const walletKeyPair = loadWalletKey(keypair);
    const anchorProgram = await loadTokenEntanglementProgream(
      walletKeyPair,
      env,
      rpcUrl,
    );
    const candyMachine = 'EpRFqiEBLKwYxqx2QMSJqSZsVRPN7bptQgkEAd3NgSMm';
    const metadataByCandyMachine = [
      ...(await getAccountsByCreatorAddress(
        candyMachine,
        anchorProgram.provider.connection,
      )),
    ];

    const oldMdByMachine = [
      ...(await getAccountsByCreatorAddress(
        'CLErvyrMpi66RAxNV2wveSi25NxHb8G383MSVuGDgZzp',
        anchorProgram.provider.connection,
      )),
      ...(await getAccountsByCreatorAddress(
        'HHGsTSzwPpYMYDGgUqssgAsMZMsYbshgrhMge8Ypgsjx',
        anchorProgram.provider.connection,
      )),
    ];

    const juiceDaoMd = [
      ...(await getAccountsByCreatorAddress(
        'Fb9shNbwzYfdPrPMvDPZxroz7aVwB7qyJ7TshjiDPo9J',
        anchorProgram.provider.connection,
      )),
    ];

    const combined = [
      ...metadataByCandyMachine.map(m =>
        new anchor.web3.PublicKey(m[0].mint).toBase58(),
      ),
      ...oldMdByMachine.map(m =>
        new anchor.web3.PublicKey(m[0].mint).toBase58(),
      ),
      ...juiceDaoMd.map(m => new anchor.web3.PublicKey(m[0].mint).toBase58()),
    ];
    fs.writeFileSync('valid_mints.json', JSON.stringify(combined));
  });

programCommand('point_to_hydra')
  .option(
    '-r, --rpc-url <string>',
    'custom rpc url since this is a heavy command',
  )
  .action(async (files: string[], cmd) => {
    const { keypair, env, rpcUrl, start } = cmd.opts();
    const walletKeyPair = loadWalletKey(keypair);
    const anchorProgram = await loadTokenEntanglementProgream(
      walletKeyPair,
      env,
      rpcUrl,
    );
    const mints = fs.readFileSync('valid_mints.json');
    const parsed = JSON.parse(mints.toString());
    let instructions = [];
    const metadataAddresses = [];
    for (let i = 0; i < parsed.length; i++) {
      metadataAddresses.push(
        await getMetadata(new anchor.web3.PublicKey(parsed[i])),
      );
    }
    const metadataAccounts = await getMultipleAccounts(
      anchorProgram.provider.connection,
      metadataAddresses,
    );
    await Promise.all(
      chunks(metadataAccounts, 1000).map(async slice => {
        for (let j = 0; j < slice.length; j++) {
          const metadata = decodeMetadata(slice[j].account.data);
          try {
            if (
              metadata.data.creators[1].share < 68 &&
              new anchor.web3.PublicKey(metadata.updateAuthority).equals(
                walletKeyPair.publicKey,
              )
            ) {
              const newData = new Data({
                ...metadata.data,
                creators: [
                  metadata.data.creators[0],
                  new Creator({
                    address: new anchor.web3.PublicKey(
                      'trshC9cTgL3BPXoAbp5w9UfnUMWEJx5G61vUijXPMLH',
                    ).toBase58(),
                    verified: 1,
                    share: 68,
                  }),
                  new Creator({
                    address: new anchor.web3.PublicKey(
                      'ENACtpCWKJAomGtWVH2UqdNKmkR1Ft4V81gC4oUbi5W1',
                    ).toBase58(),
                    verified: 0,
                    share: 26,
                  }),
                  new Creator({
                    address: new anchor.web3.PublicKey(
                      '8BoJdKKz3j4bUGJdAdGhaiSpv1EM9HhSm1cjy1iPrfhk',
                    ).toBase58(),
                    verified: 0,
                    share: 5,
                  }),
                  new Creator({
                    address: new anchor.web3.PublicKey(
                      '3B86L4BrRjm9V7sd3AjjJq5XFtyqMgCYMCTwqMMvAxgr',
                    ).toBase58(),
                    verified: 0,
                    share: 1,
                  }),
                ],
              });

              const value = new UpdateMetadataArgs({
                data: newData,
                updateAuthority: walletKeyPair.publicKey.toBase58(),
                primarySaleHappened: null,
              });
              const txnData = Buffer.from(serialize(METADATA_SCHEMA, value));
              console.log(
                'Writing to update',
                metadata.mint,
                metadata.data.name,
                metadata.data.uri,
              );

              instructions.push(
                createUpdateMetadataInstruction(
                  slice[j].publicKey,
                  walletKeyPair.publicKey,
                  txnData,
                ),
              );
            } else {
              console.log(
                'Skipping, already done',
                slice[j].publicKey.toBase58(),
                metadata.mint,
              );
            }
            if (instructions.length >= 3) {
              try {
                await sendTransactionWithRetryWithKeypair(
                  anchorProgram.provider.connection,
                  walletKeyPair,
                  instructions,
                  [],
                  'single',
                );
              } catch (e) {
                console.error(e);
                console.log('Failed txn');
              }
              console.log('At position', j);
              instructions = [];
            }
          } catch (e) {
            console.error(e);
            console.log('done');
          }
        }

        if (instructions.length >= 0) {
          try {
            await sendTransactionWithRetryWithKeypair(
              anchorProgram.provider.connection,
              walletKeyPair,
              instructions,
              [],
              'single',
            );
          } catch (e) {
            console.log('Failed txn');
          }
          console.log('At position end');
          instructions = [];
        }
      }),
    );
  });
programCommand('send_trash_tokens')
  .option(
    '-r, --rpc-url <string>',
    'custom rpc url since this is a heavy command',
  )
  .action(async (files: string[], cmd) => {
    const { keypair, env, rpcUrl, start } = cmd.opts();
    const walletKeyPair = loadWalletKey(keypair);
    const anchorProgram = await loadTokenEntanglementProgream(
      walletKeyPair,
      env,
      rpcUrl,
    );
    const wallets = fs.readFileSync('current-wallets.json');
    const parsed = JSON.parse(wallets.toString());

    let instructions = [];
    let keys = Object.keys(parsed);
    const mint = new anchor.web3.PublicKey(
      'qJLsXzVbkV6ddbCW3NcX5KRZ5PHnKLMaps7ucMgwPyG',
    );
    const myAcct = (await getAtaForMint(mint, walletKeyPair.publicKey))[0];
    for (let i = 0; i < keys.length; i++) {
      const wallet = new anchor.web3.PublicKey(keys[i]);
      const amount = parsed[keys[i]];

      const theirAcct = (await getAtaForMint(mint, wallet))[0];

      const exists = await anchorProgram.provider.connection.getAccountInfo(
        theirAcct,
      );

      let bal = 0;
      try {
        bal = (
          await anchorProgram.provider.connection.getTokenAccountBalance(
            theirAcct,
          )
        ).value.uiAmount;
      } catch (e) {}

      if (!exists || (bal >= 0 && bal < amount)) {
        console.log('Wallet ', wallet.toBase58(), amount, bal, amount - bal);

        if (!exists)
          instructions.push(
            createAssociatedTokenAccountInstruction(
              theirAcct,
              walletKeyPair.publicKey,
              wallet,
              mint,
            ),
          );

        instructions.push(
          Token.createTransferCheckedInstruction(
            TOKEN_PROGRAM_ID,
            myAcct,
            mint,
            theirAcct,
            walletKeyPair.publicKey,
            [],
            amount - bal,
            0,
          ),
        );
      }
      if (instructions.length >= 10) {
        try {
          await sendTransactionWithRetryWithKeypair(
            anchorProgram.provider.connection,
            walletKeyPair,
            instructions,
            [],
            'single',
          );
        } catch (e) {
          console.log('Failed txn');
        }
        console.log('At position', i);
        instructions = [];
      }
    }
  });

programCommand('close_all_accounts')
  .option(
    '-r, --rpc-url <string>',
    'custom rpc url since this is a heavy command',
  )
  .action(async (files: string[], cmd) => {
    const { keypair, env, rpcUrl, start } = cmd.opts();
    const walletKeyPair = loadWalletKey(keypair);
    const anchorProgram = await loadTokenEntanglementProgream(
      walletKeyPair,
      env,
      rpcUrl,
    );
    const candyMachine = 'EpRFqiEBLKwYxqx2QMSJqSZsVRPN7bptQgkEAd3NgSMm';
    const currentAgesText = fs.readFileSync('new_sets.json');
    const parsed = JSON.parse(currentAgesText.toString());
    const metadataByCandyMachine = [
      ...(await getAccountsByCreatorAddress(
        candyMachine,
        anchorProgram.provider.connection,
      )),
    ];

    await Promise.all(
      chunks(Array.from(Array(metadataByCandyMachine.length).keys()), 500).map(
        async allIndexesInSlice => {
          let instructions = [];
          for (let i = 0; i < allIndexesInSlice.length; i++) {
            const md = metadataByCandyMachine[allIndexesInSlice[i]][0];
            const key = (
              await getAtaForMint(
                new anchor.web3.PublicKey(md.mint),
                walletKeyPair.publicKey,
              )
            )[0];
            let exists;
            try {
              exists =
                await anchorProgram.provider.connection.getTokenAccountBalance(
                  key,
                );
              console.log('Exists value is', exists.value.uiAmount);
              if (exists.value.uiAmount == 0) {
                instructions.push(
                  Token.createCloseAccountInstruction(
                    TOKEN_PROGRAM_ID,
                    key,
                    walletKeyPair.publicKey,
                    walletKeyPair.publicKey,
                    [],
                  ),
                );
              }
            } catch (e) {
              console.log('account doenst exist');
            }

            if (instructions.length == 10) {
              console.log('Closing 10 accounts');
              await sendTransactionWithRetryWithKeypair(
                anchorProgram.provider.connection,
                walletKeyPair,
                instructions,
                [],
                'single',
              );
              instructions = [];
            }
          }
        },
      ),
    );
  });

programCommand('entangle_all_pairs')
  .option(
    '-r, --rpc-url <string>',
    'custom rpc url since this is a heavy command',
  )
  .action(async (files: string[], cmd) => {
    const { keypair, env, rpcUrl, start } = cmd.opts();
    const walletKeyPair = loadWalletKey(keypair);
    const anchorProgram = await loadTokenEntanglementProgream(
      walletKeyPair,
      env,
      rpcUrl,
    );
    const candyMachine = 'EpRFqiEBLKwYxqx2QMSJqSZsVRPN7bptQgkEAd3NgSMm';
    const currentAgesText = fs.readFileSync('new_sets.json');
    const parsed = JSON.parse(currentAgesText.toString());
    const metadataByCandyMachine = [
      ...(await getAccountsByCreatorAddress(
        candyMachine,
        anchorProgram.provider.connection,
      )),
    ];

    const oldMdByMachine = [
      ...(await getAccountsByCreatorAddress(
        'CLErvyrMpi66RAxNV2wveSi25NxHb8G383MSVuGDgZzp',
        anchorProgram.provider.connection,
      )),
      ...(await getAccountsByCreatorAddress(
        'HHGsTSzwPpYMYDGgUqssgAsMZMsYbshgrhMge8Ypgsjx',
        anchorProgram.provider.connection,
      )),
    ];

    await Promise.all(
      chunks(Array.from(Array(metadataByCandyMachine.length).keys()), 500).map(
        async allIndexesInSlice => {
          for (let i = 0; i < allIndexesInSlice.length; i++) {
            const md = metadataByCandyMachine[allIndexesInSlice[i]][0];
            const exists =
              await anchorProgram.provider.connection.getTokenAccountBalance(
                (
                  await getAtaForMint(
                    new anchor.web3.PublicKey(md.mint),
                    walletKeyPair.publicKey,
                  )
                )[0],
              );
            console.log('Exists value is', exists.value.uiAmount);
            if (exists.value.uiAmount > 0) {
              const otherMint = parsed.find(p => p.id == md.data.name);
              const metadataEntry = oldMdByMachine.find(
                m => m[1] == otherMint.metadata,
              );
              console.log(
                'Token',
                md.data.name,
                'Needs entanglement, found metadata',
                otherMint.metadata,
                'and mint',
                metadataEntry[0].mint,
              );

              let authorityKey: anchor.web3.PublicKey =
                  new anchor.web3.PublicKey(
                    'trshC9cTgL3BPXoAbp5w9UfnUMWEJx5G61vUijXPMLH',
                  ),
                tMintKey: anchor.web3.PublicKey;

              const mintAKey = new anchor.web3.PublicKey(metadataEntry[0].mint);
              const mintBKey = new anchor.web3.PublicKey(md.mint);

              tMintKey = WRAPPED_SOL_MINT;

              const [entangledPair, bump] = await getTokenEntanglement(
                mintAKey,
                mintBKey,
              );

              const [reverseEntangledPair, reverseBump] =
                await getTokenEntanglement(mintBKey, mintAKey);

              const [tokenAEscrow, tokenABump, tokenBEscrow, tokenBBump] =
                await getTokenEntanglementEscrows(mintAKey, mintBKey);
              const priceAdjusted = new anchor.BN(
                await getPriceWithMantissa(
                  0.5,
                  tMintKey,
                  walletKeyPair,
                  anchorProgram,
                ),
              );
              const ata = (
                await getAtaForMint(mintBKey, walletKeyPair.publicKey)
              )[0];
              const transferAuthority = anchor.web3.Keypair.generate();
              const signers = [transferAuthority];
              const instruction =
                await anchorProgram.instruction.createEntangledPair(
                  bump,
                  reverseBump,
                  tokenABump,
                  tokenBBump,
                  priceAdjusted,
                  false,
                  {
                    accounts: {
                      treasuryMint: tMintKey,
                      payer: walletKeyPair.publicKey,
                      transferAuthority: transferAuthority.publicKey,
                      authority: authorityKey,
                      mintA: mintAKey,
                      metadataA: await getMetadata(mintAKey),
                      editionA: await getMasterEdition(mintAKey),
                      mintB: mintBKey,
                      metadataB: await getMetadata(mintBKey),
                      editionB: await getMasterEdition(mintBKey),
                      tokenB: ata,
                      tokenAEscrow,
                      tokenBEscrow,
                      entangledPair,
                      reverseEntangledPair,
                      tokenProgram: TOKEN_PROGRAM_ID,
                      systemProgram: anchor.web3.SystemProgram.programId,
                      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
                    },
                  },
                );

              const instructions = [
                Token.createApproveInstruction(
                  TOKEN_PROGRAM_ID,
                  ata,
                  transferAuthority.publicKey,
                  walletKeyPair.publicKey,
                  [],
                  1,
                ),
                instruction,
                Token.createRevokeInstruction(
                  TOKEN_PROGRAM_ID,
                  ata,
                  walletKeyPair.publicKey,
                  [],
                ),
              ];

              await sendTransactionWithRetryWithKeypair(
                anchorProgram.provider.connection,
                walletKeyPair,
                instructions,
                signers,
                'max',
              );
            }
          }
        },
      ),
    );
  });
programCommand('pull_chain_result_set')
  .option(
    '-r, --rpc-url <string>',
    'custom rpc url since this is a heavy command',
  )
  .action(async (files: string[], cmd) => {
    const { keypair, env, rpcUrl, start } = cmd.opts();
    const walletKeyPair = loadWalletKey(keypair);
    const anchorProgram = await loadCandyProgram(walletKeyPair, env, rpcUrl);
    const candyMachine = 'CLErvyrMpi66RAxNV2wveSi25NxHb8G383MSVuGDgZzp';
    const currentAgesText = fs.readFileSync('sets.json');
    const parsedAges = JSON.parse(currentAgesText.toString());
    const metadataByCandyMachine = [
      ...(await getAccountsByCreatorAddress(
        candyMachine,
        anchorProgram.provider.connection,
      )),
      ...(await getAccountsByCreatorAddress(
        'HHGsTSzwPpYMYDGgUqssgAsMZMsYbshgrhMge8Ypgsjx',
        anchorProgram.provider.connection,
      )),
    ];

    const keysNotPresent = _.difference(
      metadataByCandyMachine.map(m => m[1]),
      parsedAges.map(p => p.metadata),
    );
    console.log('Key length', keysNotPresent.length);
    await Promise.all(
      chunks(Array.from(Array(keysNotPresent.length).keys()), 1000).map(
        async allIndexesInSlice => {
          for (let i = 0; i < allIndexesInSlice.length; i++) {
            const metadata = metadataByCandyMachine.find(
              m => m[1] == keysNotPresent[allIndexesInSlice[i]],
            );
            const mint = new anchor.web3.PublicKey(metadata[0].mint);
            const currentAccounts =
              await anchorProgram.provider.connection.getTokenLargestAccounts(
                mint,
              );
            const holding = currentAccounts.value.find(a => a.amount == '1');
            const token =
              await anchorProgram.provider.connection.getAccountInfo(
                holding.address,
              );
            const parsedToken = deserializeAccount(token.data);
            //console.log('Found holding address', parsedToken.owner.toBase58());
            const attributesResp = await fetch(metadata[0].data.uri);

            const json = JSON.parse(await attributesResp.text());
            const toStore: any = {};
            toStore.traits = json.attributes.reduce((h, entry) => {
              h[entry.trait_type] = entry.value;
              return h;
            }, {});
            toStore.id = json.name;
            toStore.metadata = metadata[1];
            toStore.originalMetadata = json;
            toStore.owner = parsedToken.owner.toBase58();
            parsedAges.push(toStore);

            if (i % 10 == 0) {
              fs.writeFileSync('sets.json', JSON.stringify(parsedAges));
            }
          }
        },
      ),
    );
    console.log('Done');
    fs.writeFileSync('sets.json', JSON.stringify(parsedAges));
  });

programCommand('pull_chain_rug_set')
  .option(
    '-r, --rpc-url <string>',
    'custom rpc url since this is a heavy command',
  )
  .action(async (files: string[], cmd) => {
    const { keypair, env, rpcUrl, start } = cmd.opts();
    const walletKeyPair = loadWalletKey(keypair);
    const anchorProgram = await loadCandyProgram(walletKeyPair, env, rpcUrl);
    const fairLaunch = 'BHRFPSHHtLqjbcvVCmGrCjgbUagwnKDxp4CbUgoED3tT';
    const currentAgesText = fs.readFileSync('rugs.json');
    const parsedAges = JSON.parse(currentAgesText.toString());
    const metadataByCandyMachine = [
      ...(await getAccountsByCreatorAddress(
        fairLaunch,
        anchorProgram.provider.connection,
      )),
    ];

    const keysNotPresent = _.difference(
      metadataByCandyMachine.map(m => m[1]),
      parsedAges.map(p => p.metadata),
    );
    console.log('Key length', keysNotPresent.length);
    await Promise.all(
      chunks(Array.from(Array(keysNotPresent.length).keys()), 1000).map(
        async allIndexesInSlice => {
          for (let i = 0; i < allIndexesInSlice.length; i++) {
            const metadata = metadataByCandyMachine.find(
              m => m[1] == keysNotPresent[allIndexesInSlice[i]],
            );
            const mint = new anchor.web3.PublicKey(metadata[0].mint);
            const currentAccounts =
              await anchorProgram.provider.connection.getTokenLargestAccounts(
                mint,
              );
            const holding = currentAccounts.value.find(a => a.amount == '1');
            if (holding) {
              const token =
                await anchorProgram.provider.connection.getAccountInfo(
                  holding.address,
                );
              const parsedToken = deserializeAccount(token.data);
              //console.log('Found holding address', parsedToken.owner.toBase58());
              const attributesResp = await fetch(metadata[0].data.uri);

              const json = JSON.parse(await attributesResp.text());
              const toStore = json.attributes.reduce((h, entry) => {
                h[entry.trait_type] = entry.value;
                return h;
              }, {});
              toStore.id = json.name;
              toStore.metadata = metadata[1];
              toStore.owner = parsedToken.owner.toBase58();
              toStore.mint = parsedToken.mint.toBase58();
              parsedAges.push(toStore);
            }
            if (i % 10 == 0) {
              fs.writeFileSync('rugs.json', JSON.stringify(parsedAges));
            }
          }
        },
      ),
    );
    console.log('Done');
    fs.writeFileSync('rugs.json', JSON.stringify(parsedAges));
  });

programCommand('check_new_result_set')
  .option(
    '-r, --rpc-url <string>',
    'custom rpc url since this is a heavy command',
  )
  .action(async (files: string[], cmd) => {
    const { keypair, env, rpcUrl, start } = cmd.opts();
    const walletKeyPair = loadWalletKey(keypair);
    const currentAgesText2 = fs.readFileSync('new_sets.json');
    const newSets = JSON.parse(currentAgesText2.toString());

    const stats = {
      1: {
        flippedHearts: 0,
        count: 0,
        HEAD: {
          'Rudolph Headband': 0,
          'Xmas Lights': 0,
          'Xmas Crown': 0,
          'Santa Hat': 0,
          Original: 0,
        },
        BODY: {
          'Santa Jacket': 0,
          'Elf Jacket': 0,
          Original: 0,
        },
      },
      2: {
        flippedHearts: 0,
        count: 0,
        HEAD: {
          'Rudolph Headband': 0,
          'Xmas Lights': 0,
          'Xmas Crown': 0,
          'Santa Hat': 0,
          Original: 0,
        },
        BODY: {
          'Santa Jacket': 0,
          'Elf Jacket': 0,
          Original: 0,
        },
      },
      3: {
        flippedHearts: 0,
        count: 0,
        HEAD: {
          'Rudolph Headband': 0,
          'Xmas Lights': 0,
          'Xmas Crown': 0,
          'Santa Hat': 0,
          Original: 0,
        },
        BODY: {
          'Santa Jacket': 0,
          'Elf Jacket': 0,
          Original: 0,
        },
      },
      4: {
        flippedHearts: 0,
        count: 0,
        HEAD: {
          'Rudolph Headband': 0,
          'Xmas Lights': 0,
          'Xmas Crown': 0,
          'Santa Hat': 0,
          Original: 0,
        },
        BODY: {
          'Santa Jacket': 0,
          'Elf Jacket': 0,
          Original: 0,
        },
      },
      5: {
        flippedHearts: 0,
        count: 0,
        HEAD: {
          'Rudolph Headband': 0,
          'Xmas Lights': 0,
          'Xmas Crown': 0,
          'Santa Hat': 0,
          Original: 0,
        },
        BODY: {
          'Santa Jacket': 0,
          'Elf Jacket': 0,
          Original: 0,
        },
      },
      6: {
        flippedHearts: 0,
        count: 0,
        HEAD: {
          'Rudolph Headband': 0,
          'Xmas Lights': 0,
          'Xmas Crown': 0,
          'Santa Hat': 0,
          Original: 0,
        },
        BODY: {
          'Santa Jacket': 0,
          'Elf Jacket': 0,
          Original: 0,
        },
      },
    };

    for (let i = 0; i < newSets.length; i++) {
      const set = newSets[i];
      const tier = stats[set.moddedHearts];
      if (set.moddedHearts != set.traits['❤️']) tier.flippedHearts++;
      tier.HEAD[set.newTraits.HEAD]++;
      tier.BODY[set.newTraits.BODY]++;
      tier.count++;
    }

    for (let i = 1; i < 7; i++) {
      const tier = stats[i];
      tier.flippedHearts = tier.flippedHearts / tier.count;
      const headKeys = Object.keys(tier.HEAD);
      headKeys.forEach(h => (tier.HEAD[h] /= tier.count));
      const bodyKeys = Object.keys(tier.BODY);
      bodyKeys.forEach(h => (tier.BODY[h] /= tier.count));
    }

    console.log('Stats', stats);
  });

programCommand('export_result_set_to_psd')
  .option(
    '-r, --rpc-url <string>',
    'custom rpc url since this is a heavy command',
  )
  .action(async (files: string[], cmd) => {
    const { keypair, env, rpcUrl, start } = cmd.opts();
    const currentAgesText2 = fs.readFileSync('new_sets.json');
    const newSets = JSON.parse(currentAgesText2.toString());
    const forPSD = [];
    for (let i = 0; i < newSets.length; i++) {
      const set = newSets[i];
      const newTraits = set.newTraits;
      let naughty = false;
      if (newTraits.HEAD == 'Original' && newTraits.BODY == 'Original') {
        naughty = true;
      }
      if (newTraits.HEAD == 'Original') newTraits.HEAD = set.traits.HEAD;
      if (newTraits.BODY == 'Original') newTraits.BODY = set.traits.BODY;

      const traitsForLayers = { ...newTraits };
      delete traitsForLayers['❤️'];
      delete traitsForLayers['EXALTED_STAT'];

      if (naughty) {
        newTraits.Naughty = 'True';
      } else {
        newTraits.Naughty = 'False';
      }

      const newMetadata = set.originalMetadata;
      let head = newMetadata.attributes.find(a => a.trait_type == 'HEAD');
      let body = newMetadata.attributes.find(a => a.trait_type == 'BODY');
      let heart = newMetadata.attributes.find(a => a.trait_type == '❤️');
      heart.trait_type = 'Naughty';
      heart.value = newTraits.Naughty;
      newMetadata.image = `${i}.png`;
      newMetadata.properties.files = [{ uri: `${i}.png`, type: 'image/png' }];

      head.value = newTraits.HEAD;
      body.value = newTraits.BODY;

      fs.writeFileSync(
        'xmas/' + i.toString() + '.json',
        JSON.stringify(newMetadata),
      );
      forPSD.push(traitsForLayers);
    }

    fs.writeFileSync('xmas_set_final.json', JSON.stringify(forPSD));
  });

programCommand('create_new_result_set')
  .option(
    '-r, --rpc-url <string>',
    'custom rpc url since this is a heavy command',
  )
  .action(async (files: string[], cmd) => {
    const { keypair, env, rpcUrl, start } = cmd.opts();
    const walletKeyPair = loadWalletKey(keypair);
    const currentAgesText = fs.readFileSync('sets.json');
    const currentAgesText2 = fs.readFileSync('new_sets.json');
    const currentAgesText3 = fs.readFileSync('rugs.json');
    const parsedSets = JSON.parse(currentAgesText.toString());
    const newSets = JSON.parse(currentAgesText2.toString());
    const rugs = JSON.parse(currentAgesText3.toString());

    const rugsByOwner = {};
    rugs.map(r => {
      if (!rugsByOwner[r.owner])
        rugsByOwner[r.owner] = {
          Black: 0,
          Green: 0,
          Gold: 0,
          Blue: 0,
          Red: 0,
          Purple: 0,
        };
      const type = r['background'];

      rugsByOwner[r.owner][type]++;
    });
    const keysNotPresent = _.difference(
      parsedSets.map(p => p.metadata),
      newSets.map(m => m.metadata),
    );
    console.log(rugsByOwner);
    console.log('Key length', keysNotPresent.length);
    await Promise.all(
      chunks(Array.from(Array(keysNotPresent.length).keys()), 1000).map(
        async allIndexesInSlice => {
          for (let i = 0; i < allIndexesInSlice.length; i++) {
            const currSet = parsedSets[allIndexesInSlice[i]];
            const rugs = rugsByOwner[currSet.owner];
            let completeSet =
              rugs &&
              rugs.Black > 0 &&
              rugs.Green > 0 &&
              rugs.Gold > 0 &&
              rugs.Blue > 0 &&
              rugs.Red > 0 &&
              rugs.Purple > 0;

            let partialSet = rugs
              ? rugs.Black +
                  rugs.Green +
                  rugs.Gold +
                  rugs.Blue +
                  rugs.Red +
                  rugs.Purple >=
                3
              : false;

            let hearts = currSet.traits['❤️'];

            if (hearts) {
              if (completeSet) hearts -= 2;
              else if (partialSet) hearts--;
              hearts = Math.max(1, hearts);

              const probabilityTier = TIERS[hearts];
              const newSet = generateRandomSet(probabilityTier, {});
              currSet.moddedHearts = hearts;
              currSet.newTraits = { ...currSet.traits, ...newSet };
              console.log(
                'For',
                currSet.metadata,
                'holder',
                currSet.owner,
                'has complete set?',
                completeSet,
                'partial?',
                partialSet,
                'original hearts is',
                currSet.traits['❤️'],
                'eventual hearts is',
                hearts,
                'new set is',
                newSet,
                rugs,
              );
              newSets.push(currSet);
            }
            if (i % 10 == 0) {
              fs.writeFileSync('new_sets.json', JSON.stringify(newSets));
            }
          }
        },
      ),
    );
    console.log('Done');
    fs.writeFileSync('new_sets.json', JSON.stringify(newSets));
  });

programCommand('unique_wallets')
  .option(
    '-r, --rpc-url <string>',
    'custom rpc url since this is a heavy command',
  )
  .action(async (files: string[], cmd) => {
    const { keypair, env, rpcUrl, start } = cmd.opts();
    const walletKeyPair = loadWalletKey(keypair);
    const anchorProgram = await loadCandyProgram(walletKeyPair, env, rpcUrl);
    const candyMachine = 'CLErvyrMpi66RAxNV2wveSi25NxHb8G383MSVuGDgZzp';
    const parsedWallets = {};
    const metadataByCandyMachine = [
      ...(await getAccountsByCreatorAddress(
        candyMachine,
        anchorProgram.provider.connection,
      )),
      ...(await getAccountsByCreatorAddress(
        'HHGsTSzwPpYMYDGgUqssgAsMZMsYbshgrhMge8Ypgsjx',
        anchorProgram.provider.connection,
      )),
      ...(await getAccountsByCreatorAddress(
        'EpRFqiEBLKwYxqx2QMSJqSZsVRPN7bptQgkEAd3NgSMm',
        anchorProgram.provider.connection,
      )),
    ];

    await Promise.all(
      chunks(Array.from(Array(metadataByCandyMachine.length).keys()), 1000).map(
        async allIndexesInSlice => {
          for (let i = 0; i < allIndexesInSlice.length; i++) {
            const metadata = metadataByCandyMachine[allIndexesInSlice[i]];
            const mint = new anchor.web3.PublicKey(metadata[0].mint);
            const currentAccounts =
              await anchorProgram.provider.connection.getTokenLargestAccounts(
                mint,
              );
            const holding = currentAccounts.value.find(a => a.amount == '1');
            if (holding) {
              const account =
                await anchorProgram.provider.connection.getAccountInfo(
                  holding.address,
                );

              const asToken = deserializeAccount(account.data);

              const tokenOwner =
                await anchorProgram.provider.connection.getAccountInfo(
                  asToken.owner,
                );

              if (
                tokenOwner &&
                tokenOwner.owner.toBase58() !=
                  TOKEN_ENTANGLEMENT_PROGRAM_ID.toBase58()
              ) {
                console.log('Found holding address', asToken.owner.toBase58());
                if (!parsedWallets[asToken.owner.toBase58()])
                  parsedWallets[asToken.owner.toBase58()] = 1;
                else parsedWallets[asToken.owner.toBase58()]++;
              }
            }
            if (i % 10 == 0) {
              fs.writeFileSync(
                'current-wallets.json',
                JSON.stringify(parsedWallets),
              );
            }
          }
        },
      ),
    );
    console.log('Done');
    console.log('Unique count', Object.keys(parsedWallets).length);
    fs.writeFileSync('current-wallets.json', JSON.stringify(parsedWallets));
  });

programCommand('trash_list')
  .option(
    '-r, --rpc-url <string>',
    'custom rpc url since this is a heavy command',
  )
  .action(async (files: string[], cmd) => {
    const { keypair, env, rpcUrl, start } = cmd.opts();
    const walletKeyPair = loadWalletKey(keypair);
    const anchorProgram = await loadCandyProgram(walletKeyPair, env, rpcUrl);
    const parsedWallets = {};
    const stolenTrash = {};
    const metadataByCandyMachine = [
      ...(await getAccountsByCreatorAddress(
        'CApZmLZAwjTm59pc6rKJ85sux4wCJsLS7RMV1pUkMeVK',
        anchorProgram.provider.connection,
      )),
    ];

    await Promise.all(
      chunks(Array.from(Array(metadataByCandyMachine.length).keys()), 1000).map(
        async allIndexesInSlice => {
          for (let i = 0; i < allIndexesInSlice.length; i++) {
            const metadata = metadataByCandyMachine[allIndexesInSlice[i]];
            const mint = new anchor.web3.PublicKey(metadata[0].mint);
            const currentAccounts =
              await anchorProgram.provider.connection.getTokenLargestAccounts(
                mint,
              );
            const holding = currentAccounts.value.find(a => a.amount == '1');
            if (holding) {
              const account =
                await anchorProgram.provider.connection.getAccountInfo(
                  holding.address,
                );

              const asToken = deserializeAccount(account.data);

              const tokenOwner =
                await anchorProgram.provider.connection.getAccountInfo(
                  asToken.owner,
                );

              if (tokenOwner) {
                console.log('Found holding address', asToken.owner.toBase58());
                if (
                  asToken.owner.toBase58() ==
                  'trshC9cTgL3BPXoAbp5w9UfnUMWEJx5G61vUijXPMLH'
                ) {
                  const sigs =
                    await anchorProgram.provider.connection.getConfirmedSignaturesForAddress2(
                      holding.address,
                    );
                  const txns =
                    await anchorProgram.provider.connection.getParsedConfirmedTransactions(
                      sigs.map(s => s.signature),
                    );
                  const txnSorted = txns.sort(
                    (a, b) => b.blockTime - a.blockTime,
                  );
                  const myAcctIndex =
                    txnSorted[0].transaction.message.accountKeys.findIndex(a =>
                      a.pubkey.equals(holding.address),
                    );

                  const mostRecentEntry = txnSorted.find(
                    t =>
                      t.meta.postTokenBalances.find(
                        tb =>
                          tb.mint == mint.toBase58() &&
                          tb.accountIndex == myAcctIndex,
                      )?.uiTokenAmount?.uiAmount == 1 &&
                      t.meta.preTokenBalances.find(
                        tb =>
                          tb.mint == mint.toBase58() &&
                          tb.accountIndex != myAcctIndex,
                      )?.uiTokenAmount?.uiAmount == 1,
                  );

                  if (mostRecentEntry) {
                    stolenTrash[asToken.mint.toBase58()] =
                      mostRecentEntry.meta.preTokenBalances.find(
                        tb =>
                          tb.mint == mint.toBase58() &&
                          tb.accountIndex != myAcctIndex,
                        //@ts-ignore
                      )?.owner;
                  }
                } else if (!parsedWallets[asToken.mint.toBase58()])
                  parsedWallets[asToken.mint.toBase58()] =
                    asToken.owner.toBase58();
              }
            }
            if (i % 10 == 0) {
              fs.writeFileSync(
                'current-trash-wallets.json',
                JSON.stringify(parsedWallets),
              );
              fs.writeFileSync(
                'current-trash-pile.json',
                JSON.stringify(stolenTrash),
              );
            }
          }
        },
      ),
    );
    console.log('Done');
    console.log('Unique count', Object.keys(parsedWallets).length);
    fs.writeFileSync(
      'current-trash-wallets.json',
      JSON.stringify(parsedWallets),
    );
    fs.writeFileSync('current-trash-pile.json', JSON.stringify(stolenTrash));
  });

programCommand('sign_mints')
  .option(
    '-r, --rpc-url <string>',
    'custom rpc url since this is a heavy command',
  )
  .option(
    '-m --mintsFile <string>',
    'path to the json file containing a list of mints to sign the metadata of',
  )
  .option('-i --index <number>', 'index to start signing at in the file')
  .action(async (files: string[], cmd) => {
    const { keypair, env, rpcUrl, mintsFile, index, start } = cmd.opts();
    let parsedMints = JSON.parse(fs.readFileSync(mintsFile).toString());
    if (index !== undefined) {
      parsedMints = parsedMints.slice(index);
    }
    let i = 0;
    for (let mint of parsedMints) {
      const metadata = await getMetadata(new anchor.web3.PublicKey(mint));
      console.log('got md:', metadata.toString());
      try {
        await signMetadata(metadata.toString(), keypair, env, rpcUrl);
        console.log('signed md', i);
        i++;
        await sleep(100);
      } catch {
        console.log("tx failed, retry with param: '-i " + i + "'");
      }
    }
  });

function programCommand(name: string) {
  return program
    .command(name)
    .option(
      '-e, --env <string>',
      'Solana cluster env name',
      'devnet', //mainnet-beta, testnet, devnet
    )
    .option(
      '-k, --keypair <path>',
      `Solana wallet location`,
      '--keypair not provided',
    )
    .option('-l, --log-level <string>', 'log level', setLogLevel);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function setLogLevel(value, prev) {
  if (value === undefined || value === null) {
    return;
  }
  log.info('setting the log value to: ' + value);
  log.setLevel(value);
}

program.parse(process.argv);
