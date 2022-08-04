import {  minVersionBump, nextVersion, VersionUpgrade, TokenList } from '@uniswap/token-lists';
import { getAllTokens, getTokens } from './graph';
import { constants, utils, ethers } from 'ethers'

import { ArbTokenList, ArbTokenInfo, EtherscanList, GraphTokenResult } from './types';
import {
  getL2TokenAddressesFromL1,
  getL2TokenAddressesFromL2,
  getLogoUri,
  getTokenListObj,
  listNameToFileName,
  validateTokenListWithErrorThrowing,
  sanitizeString,
  listNameToArbifiedListName,
  isArbTokenList,
  removeInvalidTokensFromList
} from './utils';
import { CallInput, constants as arbConstants, MultiCaller } from "@arbitrum/sdk"
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { getNetworkConfig } from './instantiate_bridge';

import permitTokenAbi from "../PermitTokens/permitTokenAbi.json";
import daiPermitTokenAbi from "../PermitTokens/daiPermitTokenAbi.json";
import multicallAbi from "../PermitTokens/multicallAbi.json";
import { getCorrectPermitSigNoVersion } from "../PermitTokens/permitSignature";
import { getCorrectPermitSig } from "../PermitTokens/permitSignature";
import { getDaiLikePermitSignature } from "../PermitTokens/permitSignature";
import { ERC20PermitUpgradeable } from '@arbitrum/sdk/dist/lib/abi/ERC20PermitUpgradeable';

export interface ArbificationOptions {
  overwriteCurrentList: boolean;
}

export interface L2ToL1GatewayAddresses {
  [contractAddress: string]: string;
}

//NOVAify
// TODO: read these values from the gateway or a subgraph
const l2ToL1GatewayAddresses: L2ToL1GatewayAddresses = {
  // L2 ERC20 Gateway	mainnet
  '0x09e9222e96e7b4ae2a407b98d48e330053351eee':
    '0xa3A7B6F88361F48403514059F1F16C8E78d60EeC',
  // L2 Arb-Custom Gateway	mainnet
    '0x096760f208390250649e3e8763348e783aef5562':
    '0xcEe284F754E854890e311e3280b767F80797180d',
  // L2 weth mainnet
  '0x6c411ad3e74de3e7bd422b94a27770f5b86c623b':
    '0xd92023E9d9911199a6711321D1277285e6d4e2db',
  // L2 dai gateway mainnet
  '0x467194771dae2967aef3ecbedd3bf9a310c76c65':
    '0xd3b5b60020504bc3489d6949d545893982ba3011',
  // L2 ERC20 Gateway	rinkeby
    "0x195c107f3f75c4c93eba7d9a1312f19305d6375f": "0x91169Dbb45e6804743F94609De50D511C437572E",
  // L2 Arb-Custom Gateway	rinkeby
    "0x9b014455acc2fe90c52803849d0002aeec184a06":"0x917dc9a69F65dC3082D518192cd3725E1Fa96cA2",
  // L2 Weth Gateway rinkeby
    "0xf94bc045c4e926cc0b34e8d1c41cd7a043304ac9": "0x81d1a19cf7071732D4313c75dE8DD5b8CF697eFD",
  // old L2 weth gateway in rinkeby? we can prob remove this
    "0xf90eb31045d5b924900aff29344deb42eae0b087": "0x81d1a19cf7071732D4313c75dE8DD5b8CF697eFD",
  // livepeer gateway mainnet
  "0x6d2457a4ad276000a615295f7a80f79e48ccd318": "0x6142f1C8bBF02E6A6bd074E8d564c9A5420a0676"
};

export const generateTokenList = async (
  l1TokenList: TokenList,
  prevArbTokenList?: ArbTokenList,
  options?: {
    /**
     * Append all tokens from the original l1TokenList to the output list.
     */
    includeAllL1Tokens?: boolean,
    /**
     * Append all unbridged tokens from original l1TokenList to the output list.
     */
    includeUnbridgedL1Tokens?: boolean,
    getAllTokensInNetwork?: boolean,
    includeOldDataFields?: boolean
  }
) => {
  if(options?.includeAllL1Tokens && options.includeUnbridgedL1Tokens) {
    throw new Error("Cannot include both of AllL1Tokens and UnbridgedL1Tokens since UnbridgedL1Tokens is a subset of AllL1Tokens.")
  }

  const name = l1TokenList.name
  const mainLogoUri = l1TokenList.logoURI

  const { l1 , l2 } = await getNetworkConfig();

  let tokens =
    options && options.getAllTokensInNetwork
      ? await getAllTokens(l2.network.chainID)
      : await getTokens(
          l1TokenList.tokens.map((token) => ({
            addr: token.address.toLowerCase(),
            logo: token.logoURI
          })),
          l2.network.chainID
        );

  
  const l1TokenAddresses = tokens.map((token:GraphTokenResult) => token.l1TokenAddr);
  const l2AddressesFromL1 = await getL2TokenAddressesFromL1(l1TokenAddresses, l1.multiCaller, l2.network.tokenBridge.l1GatewayRouter);
  const l2AddressesFromL2 = await getL2TokenAddressesFromL2(l1TokenAddresses, l2.multiCaller, l2.network.tokenBridge.l2GatewayRouter);

  // if the l2 route hasn't been updated yet we remove the token from the bridged tokens
  tokens = tokens.filter((t, i) => l2AddressesFromL1[i] === l2AddressesFromL2[i])

  const tokenData = await l2.multiCaller.getTokenData(
    l2AddressesFromL1.map(t => t || constants.AddressZero),
    { name: true, decimals: true, symbol: true }
  )
  const logoUris: { [l1addr: string]: string } = {};
  for (const token of tokens) {
    const uri = token.logoUri || await getLogoUri(token.l1TokenAddr);
    if (uri) logoUris[token.l1TokenAddr] = uri;
  }

  let arbifiedTokenList:ArbTokenInfo[] = tokens
      .map((t, i) => ({token: t, l2Address: l2AddressesFromL2[i], tokenDatum: tokenData[i]}))
      // it's possible that even though l2AddressesFromL1[i] === l2AddressesFromL2[i] these addresses could be the zero address
      // this can happen if the graphql query returns an address that hasnt been bridged
      .filter((t): t is typeof t & { l2Address: string } => t.l2Address != undefined && t.l2Address !== constants.AddressZero)
      .map((token, i: number) => {
    const l2GatewayAddress = token.token.joinTableEntry[0].gateway.gatewayAddr;
    let { name:_name, decimals, symbol:_symbol } = token.tokenDatum;
    
    if(decimals === undefined) throw new Error(`Unexpected undefined token decimals: ${JSON.stringify(token)}`);

    _name = (() => {
      if(_name === undefined) throw new Error(`Unexpected undefined token name: ${JSON.stringify(token)}`);
      // if token name is empty, instead set the address as the name
      // we remove the initial 0x since the token list standard only allows up to 40 characters
      else if(_name === "") return token.token.l1TokenAddr.substring(2)
      // parse null terminated bytes32 strings
      else if(_name.length === 64) return utils.parseBytes32String("0x" + _name)
      else return _name;
    })()

    _symbol = (() => {
      if(_symbol === undefined) throw new Error(`Unexpected undefined token symbol: ${JSON.stringify(token)}`);
      // schema doesn't allow for empty symbols, and has a max length of 20
      else if (_symbol === "") return _name.substring(0, Math.min(_name.length, 20));
      // parse null terminated bytes32 strings
      else if (_symbol.length === 64) return utils.parseBytes32String("0x" + _symbol);
      else return _symbol;
    })()

    const name = sanitizeString(_name)
    const symbol = sanitizeString(_symbol)

    let arbTokenInfo = {
      chainId: +l2.network.chainID,
      address: token.l2Address,
      name,
      symbol,
      decimals,
      extensions: {
        bridgeInfo: {
          [l1.network.chainID]: {
            tokenAddress: token.token.l1TokenAddr,
            originBridgeAddress: l2GatewayAddress,
            destBridgeAddress: l2ToL1GatewayAddresses[l2GatewayAddress.toLowerCase()]
          }
        }
      }
    };
    if(options && options.includeOldDataFields){
      arbTokenInfo.extensions = {
        ...arbTokenInfo.extensions,
        // @ts-ignore
        l1Address: token.token.l1TokenAddr,
        l2GatewayAddress: l2GatewayAddress,
        l1GatewayAddress: l2ToL1GatewayAddresses[l2GatewayAddress.toLowerCase()]
      }
    }
    if (logoUris[token.token.l1TokenAddr]) {
      arbTokenInfo = { ...{ logoURI: logoUris[token.token.l1TokenAddr] }, ...arbTokenInfo };
    } else {
      console.log('no logo uri for ',token.token.l1TokenAddr, symbol);
      
    }

    return arbTokenInfo;
  }).filter((tokenInfo: ArbTokenInfo)=>{
    return tokenInfo.extensions && tokenInfo.extensions.bridgeInfo[l1.network.chainID].originBridgeAddress !== arbConstants.DISABLED_GATEWAY 
  })
  arbifiedTokenList.sort((a, b) => (a.symbol < b.symbol ? -1 : 1));

  console.log(`List has ${arbifiedTokenList.length} bridged tokens`);

  const allOtherTokens = l1TokenList.tokens.filter(
    (l1TokenInfo) => l1TokenInfo.chainId !== l2.network.chainID
  ).map((l1TokenInfo)=>{
      return {
        chainId: +l1TokenInfo.chainId,
        name: l1TokenInfo.name,
        address: l1TokenInfo.address,
        symbol: l1TokenInfo.symbol,
        decimals: l1TokenInfo.decimals,
        logoURI: l1TokenInfo.logoURI
      }
  })

  if(options?.includeAllL1Tokens) {
    arbifiedTokenList = arbifiedTokenList.concat(allOtherTokens)
  } else if(options?.includeUnbridgedL1Tokens) {
    const l1AddressesOfBridgedTokens = new Set(tokens.map((token)=> token.l1TokenAddr.toLowerCase()))
    const unbridgedTokens = allOtherTokens.filter((l1TokenInfo)=>{
      return !l1AddressesOfBridgedTokens.has(l1TokenInfo.address.toLowerCase()) && l1TokenInfo.chainId === +l1.network.chainID
    }).sort((a, b) => (a.symbol < b.symbol ? -1 : 1))
    console.log(`List has ${unbridgedTokens.length} unbridged tokens`);

    arbifiedTokenList = arbifiedTokenList.concat(unbridgedTokens)
  }

  const version = (()=>{
    if(prevArbTokenList){
      // @ts-ignore
      let versionBump = minVersionBump(prevArbTokenList.tokens, arbifiedTokenList)

      // tmp: library doesn't nicely handle patches (for extensions object)
      if(versionBump === VersionUpgrade.PATCH){
        versionBump = VersionUpgrade.NONE
      }
      return nextVersion(prevArbTokenList.version, versionBump)  
    }
    return  {
      major: 1,
      minor: 0,
      patch: 0,
    }
  })()

  const arbTokenList: ArbTokenList = {
    name: listNameToArbifiedListName(name),
    timestamp: new Date().toISOString(),
    version,
    tokens: arbifiedTokenList,
    logoURI: mainLogoUri
  };

  const validationTokenList: ArbTokenList = {
    ...arbTokenList,
    tokens: arbTokenList.tokens
  };
  validateTokenListWithErrorThrowing(validationTokenList);

  console.log(`Generated list with total ${arbTokenList.tokens.length} tokens`);
  console.log('version:', version);
  
  return arbTokenList;
};

export const arbifyL1List = async (pathOrUrl: string, includeOldDataFields?:boolean) => {
  const l1TokenList = await getTokenListObj(pathOrUrl);
  removeInvalidTokensFromList(l1TokenList)
  const path = process.env.PWD +
  '/src/ArbTokenLists/' +
  listNameToFileName(l1TokenList.name);
  let prevArbTokenList: ArbTokenList | undefined; 

  if(existsSync(path)){
    const data = readFileSync(path)
    console.log('Prev version of Arb List found');
    
    prevArbTokenList =  JSON.parse(data.toString()) as ArbTokenList
    isArbTokenList(prevArbTokenList)
  } 

  const l1Addresses = l1TokenList.tokens.map((token) =>
    token.address.toLowerCase()
  );

  const newList = await generateTokenList(l1TokenList, prevArbTokenList, {
    includeAllL1Tokens: true,
    includeOldDataFields
  });

  writeFileSync(path, JSON.stringify(newList));
  console.log('Token list generated at', path );
  
};

export const updateArbifiedList = async (pathOrUrl: string) => {
  const arbTokenList = await getTokenListObj(pathOrUrl);
  removeInvalidTokensFromList(arbTokenList)
  const path = process.env.PWD +
  '/src/ArbTokenLists/' +
  listNameToFileName(arbTokenList.name);
  let prevArbTokenList: ArbTokenList | undefined; 

  if(existsSync(path)){
    const data = readFileSync(path)
    console.log('Prev version of Arb List found');
    
    prevArbTokenList =  JSON.parse(data.toString()) as ArbTokenList
    isArbTokenList(prevArbTokenList)
  } 

  const newList = await generateTokenList(arbTokenList, prevArbTokenList, { 
    includeAllL1Tokens: true
  });

  writeFileSync(path, JSON.stringify(newList));
  console.log('Token list generated at', path );
  
};


// export const updateLogoURIs = async (path: string)=> {
//   const data = readFileSync(path)
//   const prevArbTokenList =  JSON.parse(data.toString()) as ArbTokenList
//   const tokens:any = []
//   for (let i = 0; i < prevArbTokenList.tokens.length; i++) {
//     const tokenInfo = {...prevArbTokenList.tokens[i]}

//     // @ts-ignore
//     const logoURI = await getLogoUri(tokenInfo.extensions.l1Address)
//     if(logoURI){
//       tokenInfo.logoURI = logoURI
//     } else {
//       console.log('not found:', tokenInfo);
//       delete  tokenInfo.logoURI 
//     }
//     tokens.push(tokenInfo) 
//   }

//   const newArbList = {...prevArbTokenList, ...{tokens: tokens}}
//   writeFileSync(path, JSON.stringify(newArbList));

// }

export const arbListtoEtherscanList = (
  arbList: ArbTokenList
): EtherscanList => {
  const list: EtherscanList = [];
  arbList.tokens.forEach(tokenInfo => {
    const { address: l2Address } = tokenInfo;
    if (tokenInfo.extensions) {
      // This assumes one origin chain; should be chill
      const originChainID = Object.keys(tokenInfo.extensions.bridgeInfo)[0];
      const { tokenAddress, originBridgeAddress, destBridgeAddress } =
        tokenInfo.extensions.bridgeInfo[originChainID];
      const data = {
        l1Address: tokenAddress,
        l2Address,
        l1GatewayAddress: destBridgeAddress,
        l2GatewayAddress: originBridgeAddress
      };
      list.push(data);
    }
  });
  return list;
};

export const permitTest = async (pathOrUrl: string) => {
  const l1TokenList = await getTokenListObj(pathOrUrl);
  removeInvalidTokensFromList(l1TokenList)

  const newList = await generateTokenList(l1TokenList, undefined, {
    includeUnbridgedL1Tokens: false,
  });
  const etherscanData = arbListtoEtherscanList(newList);
  let dict: { [key: string]: any } = {};
  
  const { l1 } = await getNetworkConfig();
  const wallet = ethers.Wallet.createRandom().connect(l1.provider);
  const spender = ethers.Wallet.createRandom().connect(l1.provider);
  const value = ethers.utils.parseUnits("1.0", 18);
  const deadline = ethers.constants.MaxUint256;
  
  const permitCalls = [];
  let hasPermit: { [key: string]: any } = {};
  const idxToAddress = [];
  let dictIdx = 0;
  const multicall = new ethers.Contract("0x5BA1e12693Dc8F9c48aAD8770482f4739bEeD696", multicallAbi, wallet);

  for(let i=0; i<newList.tokens.length; i++){
    try {
      const tokenContract = new ethers.Contract(etherscanData[i].l1Address!, permitTokenAbi['abi'], wallet);

      const signature = await getCorrectPermitSig(wallet, tokenContract, spender.address, value, deadline);
      const { v, r, s } = ethers.utils.splitSignature(signature);
      const iface = new ethers.utils.Interface(permitTokenAbi['abi']);
      const callData = iface.encodeFunctionData("permit", [ wallet.address, spender.address, value, deadline, v, r, s ]);

      // Permit no version
      const signatureNoVersion = await getCorrectPermitSigNoVersion(wallet, tokenContract, spender.address, value, deadline);
      const { v: vNo, r: rNo, s: sNo } = ethers.utils.splitSignature(signatureNoVersion);
      const callDataNoVersion = iface.encodeFunctionData("permit", [ wallet.address, spender.address, value, deadline, vNo, rNo, sNo ]);

      // DAI permit
      const daiTokenContract = new ethers.Contract(etherscanData[i].l1Address!, daiPermitTokenAbi, wallet); 
      let signatureDAI = await getDaiLikePermitSignature(wallet, daiTokenContract, spender.address, deadline);
      const { v: vDAI, r: rDAI, s: sDAI } = ethers.utils.splitSignature(signatureDAI[0]);
      const ifaceDAI = new ethers.utils.Interface(daiPermitTokenAbi);
      const callDataDAI = ifaceDAI.encodeFunctionData("permit", [ wallet.address, spender.address, signatureDAI[1], deadline, true, vDAI, rDAI, sDAI ]);

      permitCalls.push(
        {
            target: etherscanData[i].l1Address!,
            callData: callData, // normal permit
        },
        {
            target: etherscanData[i].l1Address!,
            callData: callDataNoVersion, // no version permit
        },
        {
            target: etherscanData[i].l1Address!,
            callData: callDataDAI, // DAI permit
        },
      );
      idxToAddress[dictIdx] = etherscanData[i].l1Address!;
      dictIdx += 3;

      dict[newList.tokens[i].name] = etherscanData[i].l1Address;

    } catch (e) { // if contract doesn't have permit
    }
  }
    const tryPermit = await multicall.callStatic.tryAggregate(false, permitCalls, {gasLimit: 2000000});

    for (let i=0; i < tryPermit.length; i += 3) {
      const tokenAddress = idxToAddress[i];
      if (tryPermit[i].success === true) { // if version
          hasPermit[tokenAddress] = "version";
      } else if (tryPermit[i+1].success === true) { // if no version
          hasPermit[tokenAddress] = "no version";
      } else if (tryPermit[i+2].success === true) { // if DAI version
          hasPermit[tokenAddress] = "dai";  
      }
    }

  writeFileSync(`src/ArbTokenLists/permitTokens.json`, JSON.stringify(hasPermit));
  console.log("Token list generated at src/ArbTokenLists/permitTokens.json");
};
