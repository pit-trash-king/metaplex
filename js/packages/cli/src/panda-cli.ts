#!/usr/bin/env ts-node
import * as fs from 'fs';
import * as path from 'path';
import { program } from 'commander';
import * as anchor from '@project-serum/anchor';
import fetch from 'node-fetch';

import {
  chunks,
  fromUTF8Array,
  parseDate,
  parsePrice,
} from './helpers/various';
import { AccountInfo, Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  CACHE_PATH,
  CONFIG_ARRAY_START,
  CONFIG_LINE_SIZE,
  EXTENSION_JSON,
  EXTENSION_PNG,
  CANDY_MACHINE_PROGRAM_ID,
  ARWEAVE_PAYMENT_WALLET,
} from './helpers/constants';
import {
  getBalance,
  getCandyMachineAddress,
  getProgramAccounts,
  loadCandyProgram,
  loadWalletKey,
  AccountAndPubkey,
  deserializeAccount,
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
import { createUpdateMetadataInstruction } from './helpers/instructions';

import FormData from 'form-data';
import { stat } from 'fs/promises';
import { calculate } from '@metaplex/arweave-cost';
import { sendTransactionWithRetryWithKeypair } from './helpers/transactions';

program.version('0.0.2');

if (!fs.existsSync(CACHE_PATH)) {
  fs.mkdirSync(CACHE_PATH);
}

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
              metadataAddresses.map(a => new PublicKey(a.split('.')[0])),
            );
            for (let j = 0; j < metadataAccounts.length; j++) {
              const metadata = decodeMetadata(metadataAccounts[j].account.data);

              const newLink = await arweaveUpload(
                walletKeyPair,
                anchorProgram,
                env,
                fs.readFileSync(
                  'replacements/' + metadataAccounts[j].publicKey + '.json',
                ), // TODO rename metadataBuffer
              );
              const newData = new Data({
                ...metadata.data,
                creators: metadata.data.creators.map(
                  c =>
                    new Creator({
                      ...c,
                      address: new PublicKey(c.address).toBase58(),
                    }),
                ),
                uri: newLink,
              });

              const value = new UpdateMetadataArgs({
                data: newData,
                updateAuthority: walletKeyPair.publicKey.toBase58(),
                primarySaleHappened: null,
              });
              const txnData = Buffer.from(serialize(METADATA_SCHEMA, value));
              console.log("Writing to update", metadataAccounts[j].publicKey.toBase58())
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
            }
          }
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
    const keys = []
    for(let i = 0; i < beforekeys.length; i++) {
        if(!fs.existsSync('replacements/' + beforekeys[i] + '.json')) {
            keys.push(beforekeys[i])
        }
    }
    console.log("Keys to do", keys.length)
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
              metadataAddresses.map(a => new PublicKey(a)),
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
                for (let k = 0; levelMeter.length; k++) {
                  const currLevel = levelMeter[k];
                  if (currLevel > val) {
                    myLevel = k + 1;
                    break;
                  }
                }
              }

              existingAttr.value = myLevel;
              console.log("Writing", metadataAccounts[j].publicKey.toBase58())
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
    const metadataByCandyMachine = await getAccountsByCreatorAddress(
      candyMachine,
      anchorProgram.provider.connection,
    );

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
            const mint = new PublicKey(metadata[0].mint);
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
                    x.program == 'spl-token' &&
                    x.parsed.type == 'approve' &&
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
