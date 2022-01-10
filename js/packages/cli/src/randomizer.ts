import { program } from 'commander';
import { loadCache } from './helpers/cache';
import log from 'loglevel';
import { PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import { CACHE_PATH } from './helpers/constants';
const LOOKUP = {
  Yogi: 2500,

  Cashgrab: 2000,

  Bees: 2000,

  Ded: 1000,

  Hostage: 500,

  Uhoh: 500,

  Fine: 500,

  Pic: 500,

  NGMI: 250,

  Trash: 150,

  Bardy: 90,

  Redacted: 10,
};
program.version('0.0.2');

if (!fs.existsSync(CACHE_PATH)) {
  fs.mkdirSync(CACHE_PATH);
}

log.setLevel(log.levels.INFO);
function shuffle(array) {
  let currentIndex = array.length,
    randomIndex;

  // While there remain elements to shuffle...
  while (currentIndex != 0) {
    // Pick a remaining element...
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;

    // And swap it with the current element.
    [array[currentIndex], array[randomIndex]] = [
      array[randomIndex],
      array[currentIndex],
    ];
  }

  return array;
}
programCommand('randomize').action(async (directory, cmd) => {
  log.info('What');
  const { keypair, env, cacheName } = cmd.opts();
  const cacheContent = loadCache(cacheName, env);

  const newCache = { program: {}, items: {} };

  const keys = Object.keys(cacheContent.items);
  let arr = [];
  for (let i = 0; i < keys.length; i++) {
    const currItem = cacheContent.items[keys[i]];
    const matchingCount = LOOKUP[currItem.name];

    for (let j = 0; j < matchingCount; j++) {
      arr.push({ ...currItem, onChain: false });
    }
  }

  let randomized = shuffle(arr);

  for (let i = 0; i < randomized.length; i++) {
    newCache.items[i.toString()] = randomized[i];
  }

  let data = JSON.stringify(newCache);
  fs.writeFileSync(CACHE_PATH + '/' + env + '-' + cacheName + '-modded', data);
  log.info('randomizer finished');
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
    .option('-l, --log-level <string>', 'log level', setLogLevel)
    .option('-c, --cache-name <string>', 'Cache file name', 'temp');
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
