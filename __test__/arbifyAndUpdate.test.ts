import { ArbTokenList, EtherscanList } from '../src/lib/types';
import { yargsInstance } from '../src/main';
import { handler as handlerAllTokensList } from '../src/commands/allTokensList';
import { handler as handlerArbify } from '../src/commands/arbify';
import { handler as handlerFull } from '../src/commands/full';
import { handler as handlerUpdate } from '../src/commands/update';
import { Action, Args } from '../src/lib/options';
import { writeToFile } from '../src/lib/store';

const handlers: {
  [action in Action]?: (argv: Args) => Promise<ArbTokenList | EtherscanList>;
} = {
  [Action.AllTokensList]: handlerAllTokensList,
  [Action.Arbify]: handlerArbify,
  [Action.Full]: handlerFull,
  [Action.Update]: handlerUpdate,
};
const runCommand = async (command: Action, options: string[]) => {
  const argv = await yargsInstance.parseAsync(['_', command, ...options]);
  return handlers[command]!(argv);
};
const testNoDuplicates = (arbTokenList: ArbTokenList) => {
  const dups = findDuplicateTokens(arbTokenList);
  expect(dups).toMatchObject([]);
};
// check for top-level duplicate token (i.e. same adddress on the same chain)
const findDuplicateTokens = (arbTokenList: ArbTokenList) => {
  const appearanceCount: {
    [asdf: string]: number;
  } = {};

  arbTokenList.tokens.forEach(token => {
    const uniqueID = `${token.address},,${token.chainId}`;
    if (appearanceCount[uniqueID]) {
      appearanceCount[uniqueID]++;
    } else {
      appearanceCount[uniqueID] = 1;
    }
  });
  return Object.keys(appearanceCount).filter(uniqueID => {
    return appearanceCount[uniqueID] > 1;
  });
};
describe('Arbify and Update', () => {
  jest.setTimeout(200_000);

  it('should has the same value using external url', async () => {
    const arbifyList = await runCommand(Action.Arbify, [
      '--l2NetworkID=42161',
      '--tokenList= https://gateway.ipfs.io/ipns/tokens.uniswap.org',
      '--ignorePreviousList=true',
      '--newArbifiedList=./src/ArbTokenLists/arbed_list.json',
    ]);
    testNoDuplicates(arbifyList as ArbTokenList);
    const pathTo = './src/ArbTokenLists/copied_arbed_list.json';
    writeToFile(arbifyList, pathTo);
    const arbed_new_list = await runCommand(Action.Arbify, [
      '--l2NetworkID=42161',
      '--tokenList=https://gateway.ipfs.io/ipns/tokens.uniswap.org',
      '--prevArbifiedList=./src/ArbTokenLists/arbed_list.json',
      '--newArbifiedList=./src/ArbTokenLists/arbed_new_list.json',
    ]);
    const update_new_list = await runCommand(Action.Update, [
      '--l2NetworkID=42161',
      '--tokenList=https://gateway.ipfs.io/ipns/tokens.uniswap.org',
      `--prevArbifiedList=${pathTo}`,
    ]);

    //compareLists(arbed_new_list, update_new_list);
    const l1 = arbed_new_list;
    const l2 = update_new_list;
    if ('timestamp' in l1 && 'timestamp' in l2) {
      const { timestamp: t1, version: v1, name: n1, ...list1 } = l1;
      const { timestamp: t2, version: v2, name: n2, ...list2 } = l2;
      return expect(list1).toStrictEqual(list2);
    }

    expect(l1).toStrictEqual(l2);
  });

  it('should has the same value using current l2 list in update', async () => {
    const arbifyList = await runCommand(Action.Arbify, [
      '--l2NetworkID=42161',
      '--tokenList= https://gateway.ipfs.io/ipns/tokens.uniswap.org',
      '--ignorePreviousList=true',
      '--newArbifiedList=./src/ArbTokenLists/arbed_list.json',
    ]);
    testNoDuplicates(arbifyList as ArbTokenList);
    const pathTo = './src/ArbTokenLists/copied_arbed_list.json';
    writeToFile(arbifyList, pathTo);
    const arbed_new_list = await runCommand(Action.Arbify, [
      '--l2NetworkID=42161',
      '--tokenList=https://gateway.ipfs.io/ipns/tokens.uniswap.org',
      '--ignorePreviousList=true',
      '--prevArbifiedList=./src/ArbTokenLists/arbed_list.json',
      '--newArbifiedList=./src/ArbTokenLists/arbed_new_list.json',
    ]);
    const update_new_list = await runCommand(Action.Update, [
      '--l2NetworkID=42161',
      '--tokenList=./src/ArbTokenLists/arbed_list.json',
      '--ignorePreviousList=true',
      `--prevArbifiedList=${pathTo}`,
    ]);

    //compareLists(arbed_new_list, update_new_list);
    const l1 = arbed_new_list;
    const l2 = update_new_list;
    if ('timestamp' in l1 && 'timestamp' in l2) {
      const { timestamp: t1, version: v1, name: n1, tags: tgs1, ...list1 } = l1;
      const { timestamp: t2, version: v2, name: n2, tags: tgs2, ...list2 } = l2;
      return expect(list1).toStrictEqual(list2);
    }

    expect(l1).toStrictEqual(l2);
    //expect.assertions(2);
  });
});
