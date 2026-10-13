import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import type { Server } from 'node:http'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  Contract,
  getBytes,
  hashMessage,
  hexlify,
  JsonRpcProvider,
  parseEther,
  toUtf8Bytes,
  TypedDataEncoder,
  Wallet,
  ZeroAddress
} from 'ethers'
import { deployInfrastructure } from '../infrastructure'
import { startLocalRelay } from '../relay'
import { AccountsController } from '../../src/ambire-common/src/controllers/accounts/accounts'
import { DarknonceController } from '../../src/ambire-common/src/controllers/darknonce/darknonce'
import { KeystoreController } from '../../src/ambire-common/src/controllers/keystore/keystore'
import { SignMessageController } from '../../src/ambire-common/src/controllers/signMessage/signMessage'
import {
  SignAccountOpController,
  SigningStatus,
  type OnboardingSuccessProps
} from '../../src/ambire-common/src/controllers/signAccountOp/signAccountOp'
import { SignAccountOpPreferenceController } from '../../src/ambire-common/src/controllers/signAccountOp/signAccountOpPreference'
import { StorageController } from '../../src/ambire-common/src/controllers/storage/storage'
import { UiController } from '../../src/ambire-common/src/controllers/ui/ui'
import { mockUiManager } from '../../src/ambire-common/test/helpers/ui'
import type { Account } from '../../src/ambire-common/src/interfaces/account'
import type { IInviteController } from '../../src/ambire-common/src/interfaces/invite'
import type { IActivityController } from '../../src/ambire-common/src/interfaces/activity'
import type { IDappsController } from '../../src/ambire-common/src/interfaces/dapp'
import type { IFeatureFlagsController } from '../../src/ambire-common/src/interfaces/featureFlags'
import type { IPhishingController } from '../../src/ambire-common/src/interfaces/phishing'
import type { IPortfolioController } from '../../src/ambire-common/src/interfaces/portfolio'
import type { INetworksController, Network } from '../../src/ambire-common/src/interfaces/network'
import type { IProvidersController } from '../../src/ambire-common/src/interfaces/provider'
import type { IRequestsController } from '../../src/ambire-common/src/interfaces/requests'
import type { Storage } from '../../src/ambire-common/src/interfaces/storage'
import { SignMessageStatus } from '../../src/ambire-common/src/interfaces/signMessage'
import type { AccountOp } from '../../src/ambire-common/src/libs/accountOp/accountOp'
import { getBaseAccount } from '../../src/ambire-common/src/libs/account/getBaseAccount'
import { BROADCAST_OPTIONS } from '../../src/ambire-common/src/libs/broadcast/broadcast'
import {
  createDarknonceTree,
  darknonceModule,
  deriveDarknonceKey,
  prepareDarknonceOperation,
  readDarknonceState,
  signDarknonceUserOp
} from '../../src/ambire-common/src/libs/darknonce/darknonce'
import {
  signDarknonceAccountOperation,
  shouldRotateDarknonceMessage
} from '../../src/ambire-common/src/libs/darknonce/signing'
import type { DarknonceDeployment } from '../../src/ambire-common/src/libs/darknonce/types'
import { getEstimation } from '../../src/ambire-common/src/libs/estimate/estimate'
import type { Erc4337GasLimits } from '../../src/ambire-common/src/libs/estimate/interfaces'
import type { TokenResult } from '../../src/ambire-common/src/libs/portfolio'
import { BundlerSwitcher } from '../../src/ambire-common/src/services/bundlers/bundlerSwitcher'
import { CustomBundler } from '../../src/ambire-common/src/services/bundlers/customBundler'

const provider = new JsonRpcProvider('http://127.0.0.1:18546', undefined, { cacheTimeout: -1 })
let anvil: ChildProcess
let relay: Server
let profile: DarknonceDeployment
let network: Network
let wallet: Awaited<ReturnType<typeof makeWallet>>
let account: Account
const bundler = new CustomBundler()

async function makeWallet() {
  const values = new Map<string, unknown>()
  // The same storage boundary used by the controller tests; clone to model persisted data.
  const adapter = {
    get: async (key: string, fallback?: unknown) =>
      structuredClone(values.has(key) ? values.get(key) : fallback),
    set: async (key: string, value: unknown) => {
      values.set(key, structuredClone(value))
      return null
    },
    remove: async (key: string) => {
      values.delete(key)
      return null
    }
  } as Storage
  const storage = new StorageController(adapter)
  const ui = new UiController({ uiManager: mockUiManager().uiManager })
  // Darknonce must not ask a conventional signer to use the identity key.
  const keystore = new KeystoreController('default', storage, {}, ui)
  await keystore.initialLoadPromise
  await keystore.addSecret('password', 'darknonce-test-password', '', false)
  await keystore.unlockWithSecret('password', 'darknonce-test-password')
  assert.equal(keystore.isUnlocked, true)
  const providers = { providers: { '31337': provider } } as unknown as IProvidersController
  const networks = { networks: [network] } as unknown as INetworksController
  const accounts = new AccountsController(
    storage,
    providers,
    networks,
    keystore,
    () => {},
    () => {},
    () => {},
    '',
    async () => {
      throw new Error('Darknonce must not need the Ambire relayer')
    }
  )
  await accounts.initialLoadPromise
  await accounts.accountStateInitialLoadPromise
  let deploymentRequest: Parameters<IRequestsController['build']>[0] | undefined
  const requests = {
    build: async (request: Parameters<IRequestsController['build']>[0]) => {
      deploymentRequest = request
    }
  } as unknown as IRequestsController
  const darknonce = new DarknonceController({ accounts, keystore, providers, requests })
  const errors: string[] = []
  for (const controller of [keystore, accounts, darknonce])
    controller.onError((error) => {
      errors.push(error.message)
    })
  return {
    storage,
    values,
    keystore,
    accounts,
    providers,
    networks,
    darknonce,
    errors,
    getRequest: () => deploymentRequest
  }
}

before(async () => {
  anvil = spawn(
    path.resolve(__dirname, '../node_modules/.bin/anvil'),
    ['--port', '18546', '--chain-id', '31337', '--silent'],
    { stdio: 'ignore' }
  )
  await new Promise<void>((resolve, reject) => {
    anvil.once('error', reject)
    anvil.once('spawn', resolve)
  })
  for (let attempt = 0; ; attempt++) {
    try {
      await provider.getNetwork()
      break
    } catch (error) {
      if (attempt >= 50) throw error
      await delay(50)
    }
  }
  profile = await deployInfrastructure(await provider.getSigner(0))
  relay = await startLocalRelay(provider, await provider.getSigner(0), profile, 0)
  const address = relay.address()
  assert.ok(address && typeof address !== 'string')
  network = {
    chainId: 31337n,
    name: 'Anvil',
    nativeAssetSymbol: 'ETH',
    nativeAssetName: 'Ether',
    nativeAssetId: 'ethereum',
    platformId: 'ethereum',
    rpcUrls: ['http://127.0.0.1:18546'],
    selectedRpcUrl: 'http://127.0.0.1:18546',
    customBundlerUrl: `http://127.0.0.1:${address.port}`,
    erc4337: {
      enabled: true,
      hasPaymaster: false,
      hasBundlerSupport: true,
      bundlers: ['custom'],
      defaultBundler: 'custom'
    },
    feeOptions: { is1559: true },
    rpcNoStateOverride: false,
    isSAEnabled: false,
    areContractsDeployed: false,
    features: [],
    hasRelayer: false,
    hasSingleton: false,
    predefined: false,
    has7702: false
  }
  wallet = await makeWallet()
})

after(async () => {
  relay?.closeAllConnections()
  await new Promise<void>((resolve) => {
    if (relay) relay.close(() => resolve())
    else resolve()
  })
  provider.destroy()
  anvil?.kill()
})

async function quote(calls: AccountOp['calls'], target = account, context = wallet) {
  await context.accounts.updateAccountState(target.addr, 'latest', [31337n])
  const state = context.accounts.accountStates[target.addr]!['31337']!
  const op: AccountOp = {
    id: `test-${state.erc4337Nonce}`,
    accountAddr: target.addr,
    chainId: 31337n,
    calls,
    nonce: state.erc4337Nonce,
    signingKeyAddr: state.importedAccountKeys[0]!.addr,
    signingKeyType: 'internal',
    gasLimit: null,
    gasFeePayment: null,
    signature: null
  }
  const token: TokenResult = {
    address: ZeroAddress,
    chainId: 31337n,
    name: 'Ether',
    symbol: 'ETH',
    decimals: 18,
    amount: await provider.getBalance(target.addr),
    priceIn: [],
    marketDataIn: [],
    flags: { rewardsType: null, onGasTank: false, canTopUpGasTank: false, isFeeToken: true }
  }
  const baseAccount = getBaseAccount(target, state, network, true, false)
  const estimate = await getEstimation(
    baseAccount,
    state,
    op,
    network,
    provider,
    [token],
    [],
    new BundlerSwitcher(network, () => false),
    undefined
  )
  assert.equal(estimate.criticalError, undefined, estimate.criticalError?.message)
  assert.ok(estimate.ambire && !(estimate.ambire instanceof Error))
  assert.ok(estimate.bundler && !(estimate.bundler instanceof Error))
  assert.equal(estimate.ambire.feePaymentOptions[0]!.availableAmount > 0n, true)
  const gas: Erc4337GasLimits = estimate.bundler
  const speed = gas.gasPrice.fast
  op.gasFeePayment = {
    paidBy: target.addr,
    paidByKeyType: 'internal',
    inToken: ZeroAddress,
    amount: 0n,
    simulatedGasLimit:
      baseAccount.getGasUsed(
        { bundlerEstimation: gas, flags: {}, updatedAt: Date.now() },
        { op, feeToken: token }
      ) + BigInt(gas.preVerificationGas),
    gasPrice: BigInt(speed.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(speed.maxPriorityFeePerGas),
    broadcastOption: BROADCAST_OPTIONS.byBundler,
    isGasTank: false
  }
  return { op, gas, state }
}

async function send(
  calls: AccountOp['calls'],
  target = account,
  context = wallet,
  rotateMessage = false
) {
  const { op, gas, state } = await quote(calls, target, context)
  if (rotateMessage) op.meta = { darknonceRotateMessage: true }
  const seed = await context.keystore.getSavedSeed(target.darknonce!.seedId!)
  const userOp = await signDarknonceAccountOperation({
    account: target,
    op,
    gas,
    seed,
    provider,
    network,
    bundler,
    isActive: () => true
  })
  const hash = await bundler.broadcast(userOp, network)
  const receipt = await bundler.getReceipt(hash, network)
  assert.equal(receipt.success, true)
  await context.accounts.updateAccountState(target.addr, 'latest', [31337n])
  return { userOp, state, receipt }
}

test('new account creates an encrypted dedicated seed and an unrelated wallet deploys and funds it', async () => {
  await wallet.darknonce.create(JSON.stringify(profile))
  assert.equal(wallet.errors.length, 0, wallet.errors.join('; '))
  assert.equal(wallet.accounts.accounts.length, 1)
  account = wallet.accounts.accounts[0]!
  assert.ok(account.darknonce?.seedId)
  assert.equal(wallet.keystore.seeds.length, 1)
  assert.equal(wallet.darknonce.state, null)
  const seed = await wallet.keystore.getSavedSeed(account.darknonce.seedId)
  // These booleans ensure assertion failures cannot print the generated secret.
  assert.equal(JSON.stringify(wallet.keystore.toJSON()).includes(seed.seed), false)
  assert.equal(JSON.stringify(wallet.darknonce.toJSON()).includes(seed.seed), false)
  assert.equal(JSON.stringify([...wallet.values.values()]).includes(seed.seed), false)
  const funder = await provider.getSigner(1)
  await wallet.darknonce.deploy(await funder.getAddress(), '1')
  const request = wallet.getRequest()
  assert.ok(request?.type === 'calls')
  assert.equal(request.params.userRequestParams.meta.accountAddr, await funder.getAddress())
  for (const call of request.params.userRequestParams.calls)
    await (await funder.sendTransaction(call)).wait()
  await wallet.darknonce.inspect(account.addr)
  assert.equal(wallet.darknonce.state!.treeSize, 1024)
  assert.equal(wallet.darknonce.state!.signerEpoch, 0n)
  assert.notEqual(account.associatedKeys[0], wallet.darknonce.state!.signer)
  assert.equal(await provider.getBalance(wallet.darknonce.state!.signer), 0n)
})

test('shared wallet estimates fees, signs with a derived key and broadcasts through its custom bundler', async () => {
  const recipient = Wallet.createRandom().address
  const { state } = await send([{ to: recipient, value: 321n, data: '0x' }])
  assert.equal(await provider.getBalance(recipient), 321n)
  const next = await readDarknonceState(provider, account.addr, profile)
  assert.equal(next.signerEpoch, state.darknonce!.signerEpoch + 1n)
  assert.equal(wallet.keystore.keys.length, 1, 'Only the identity key is retained in the keystore')
  assert.equal(wallet.errors.length, 0, wallet.errors.join('; '))
})

test('Ambire transaction approval controller reaches ready and signs and broadcasts a Darknonce operation', async () => {
  const recipient = Wallet.createRandom().address
  const { op } = await quote([{ to: recipient, value: 17n, data: '0x' }])
  op.signingKeyAddr = null
  op.signingKeyType = null
  op.gasFeePayment = null
  const token: TokenResult = {
    address: ZeroAddress,
    chainId: 31337n,
    name: 'Ether',
    symbol: 'ETH',
    decimals: 18,
    amount: await provider.getBalance(account.addr),
    priceIn: [{ baseCurrency: 'usd', price: 2000 }],
    marketDataIn: [],
    flags: { rewardsType: null, onGasTank: false, canTopUpGasTank: false, isFeeToken: true }
  }
  const portfolio = {
    getAccountPortfolioState: () => ({
      '31337': {
        isReady: true,
        result: { tokens: [token], feeTokens: [token], total: { usd: 2000 }, collections: [] }
      }
    }),
    addTokensToBeLearned: () => false,
    overrideSimulationResults: async () => {},
    updateSelectedAccount: async () => {}
  } as unknown as IPortfolioController
  const preferences = new SignAccountOpPreferenceController({ storage: wallet.storage })
  await preferences.initialLoadPromise
  let submitted: OnboardingSuccessProps | undefined
  const controller = new SignAccountOpController({
    callRelayer: async (path) => {
      if (path === '/v2/erc7730/account-op') return {}
      throw new Error('Darknonce must not use the Ambire relayer for execution')
    },
    accounts: wallet.accounts,
    networks: wallet.networks,
    keystore: wallet.keystore,
    portfolio,
    featureFlags: { isFeatureEnabled: () => true } as unknown as IFeatureFlagsController,
    signAccountOpPreference: preferences,
    externalSignerControllers: {},
    account,
    network,
    activity: { broadcastedButNotConfirmed: {} } as unknown as IActivityController,
    dapps: {
      onUpdate: () => () => {},
      isDappInDefaultCatalog: () => false,
      getDappVerificationBanner: () => null
    } as unknown as IDappsController,
    phishing: {
      updateAddressesBlacklistedStatus: async () => ({})
    } as unknown as IPhishingController,
    provider,
    fromRequestId: 'approval-test',
    accountOp: op,
    shouldSimulate: false,
    onBroadcastSuccess: async (result) => {
      submitted = result
    }
  })
  const errors: string[] = []
  controller.onError((error) => {
    errors.push(error.message)
  })
  try {
    for (let attempt = 0; attempt < 100 && !controller.readyToSign; attempt++) await delay(50)
    assert.equal(
      controller.readyToSign,
      true,
      `Approval errors: ${errors.join('; ')}; status: ${controller.status?.type}; errors: ${controller.errors.map((error) => error.title).join('; ')}`
    )
    assert.ok(controller.accountOp.signingKeyAddr)
    assert.notEqual(controller.accountOp.signingKeyAddr, account.associatedKeys[0])
    assert.equal(controller.accountOp.gasFeePayment!.paidBy, account.addr)
    await controller.signAndBroadcast()
    assert.equal(controller.status?.type, SigningStatus.Done, errors.join('; '))
    assert.ok(controller.accountOp.asUserOperation)
    assert.ok(submitted)
    assert.equal(
      (await bundler.getReceipt(submitted.submittedAccountOp.identifiedBy.identifier, network))
        .success,
      true
    )
    assert.equal(await provider.getBalance(recipient), 17n)
  } finally {
    controller.destroy()
  }
})

test('shared message controller signs personal and typed messages; policy expires old signatures on the next transaction', async () => {
  const messages = new SignMessageController(
    wallet.keystore,
    wallet.providers,
    wallet.networks,
    wallet.accounts,
    {},
    { isOG: false } as IInviteController
  )
  const handler = new Contract(
    account.addr,
    ['function isValidSignature(bytes32,bytes) view returns(bytes4)'],
    provider
  )
  const message = hexlify(toUtf8Bytes('Darknonce local wallet test')) as `0x${string}`
  await messages.init({
    messageToSign: {
      fromRequestId: 'personal-test',
      accountAddr: account.addr,
      chainId: 31337n,
      content: { kind: 'message', message },
      signature: null
    }
  })
  await messages.sign()
  assert.equal(messages.status, SignMessageStatus.Done)
  const oldSignature = messages.signedMessage!.signature
  const hash = hashMessage(getBytes(message))
  assert.equal(await handler.getFunction('isValidSignature')(hash, oldSignature), '0x1626ba7e')
  const typed = {
    domain: { name: 'Darknonce test', chainId: 31337n, verifyingContract: account.addr },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' }
      ],
      Test: [{ name: 'value', type: 'uint256' }]
    },
    primaryType: 'Test',
    message: { value: 7 }
  }
  await messages.init({
    messageToSign: {
      fromRequestId: 'typed-test',
      accountAddr: account.addr,
      chainId: 31337n,
      content: { kind: 'typedMessage', ...typed },
      signature: null
    }
  })
  await messages.sign()
  assert.equal(messages.status, SignMessageStatus.Done)
  assert.equal(
    await handler.getFunction('isValidSignature')(
      TypedDataEncoder.hash(typed.domain, { Test: typed.types.Test }, typed.message),
      messages.signedMessage!.signature
    ),
    '0x1626ba7e'
  )
  messages.reset()
  await wallet.darknonce.updatePolicy(account.addr, 1, 0)
  account = wallet.accounts.accounts.find((item) => item.addr === account.addr)!
  const prior = await readDarknonceState(provider, account.addr, profile)
  assert.equal(shouldRotateDarknonceMessage(account, prior), true)
  await send([])
  const current = await readDarknonceState(provider, account.addr, profile)
  assert.equal(current.messageEpoch, prior.messageEpoch + 1n)
  assert.equal(await handler.getFunction('isValidSignature')(hash, oldSignature), '0xffffffff')
  assert.equal(account.darknonce!.lastMessageRotationEpoch, current.signerEpoch.toString())
})

test('wallet forces renewal before the application and preserves its calls', async () => {
  const { op, gas } = await quote([])
  const seed = await wallet.keystore.getSavedSeed(account.darknonce!.seedId!)
  const state = await readDarknonceState(provider, account.addr, profile)
  const prepared = prepareDarknonceOperation(seed.seed, profile, 0, state, [], false)
  const tree = createDarknonceTree(seed.seed, 31337n, 0, state.treeNumber + 1, 2)
  prepared.operation.newRoot = tree.root
  prepared.operation.newTreeSize = 2
  prepared.operation.nextSigner = tree.addresses[0]!
  prepared.operation.proof = tree.proof(0)
  const userOp = await signDarknonceAccountOperation({
    account,
    op,
    gas,
    seed,
    provider,
    network,
    bundler,
    isActive: () => true
  })
  userOp.callData = darknonceModule.encodeFunctionData('execute', [prepared.operation])
  userOp.signature = await signDarknonceUserOp(userOp, profile, prepared.key)
  await bundler.broadcast(userOp, network)
  await send([])
  const threshold = await readDarknonceState(provider, account.addr, profile)
  assert.equal(threshold.index, 1)
  const recipient = Wallet.createRandom().address
  await send([{ to: recipient, value: 99n, data: '0x' }])
  const current = await readDarknonceState(provider, account.addr, profile)
  assert.equal(current.treeNumber, threshold.treeNumber + 1)
  assert.equal(current.treeSize, threshold.treeSize)
  assert.equal(
    current.signerEpoch,
    threshold.signerEpoch + 2n,
    'Renewal and application use separate signers'
  )
  assert.equal(await provider.getBalance(recipient), 99n)
})

test('fresh wallet restores only from the phrase, public chain configuration and account number after rotations and renewal', async () => {
  const seed = await wallet.keystore.getSavedSeed(account.darknonce!.seedId!)
  const recovered = await makeWallet()
  await recovered.darknonce.restore(
    JSON.stringify(profile),
    seed.seed,
    seed.seedPassphrase || '',
    0
  )
  assert.equal(recovered.errors.length, 0, recovered.errors.join('; '))
  assert.equal(recovered.darknonce.accountAddr, account.addr)
  const restored = recovered.accounts.accounts[0]!
  assert.equal(
    recovered.darknonce.state!.signer,
    deriveDarknonceKey(
      seed.seed,
      31337n,
      0,
      'transaction',
      recovered.darknonce.state!.treeNumber,
      recovered.darknonce.state!.index
    ).address
  )
  const recipient = Wallet.createRandom().address
  await send([{ to: recipient, value: 11n, data: '0x' }], restored, recovered)
  assert.equal(await provider.getBalance(recipient), 11n)
  recovered.keystore.lock()
})
