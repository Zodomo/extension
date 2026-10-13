import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  Contract,
  ContractFactory,
  hashMessage,
  JsonRpcProvider,
  parseEther,
  Wallet,
  ZeroAddress
} from 'ethers'
import { deployInfrastructure } from '../infrastructure'
import {
  createDarknonceTree,
  darknonceModule,
  darknoncePath,
  darknonceSafe,
  deriveDarknonceKey,
  getDarknonceCreation,
  hashDarknonceUserOp,
  needsDarknonceRenewal,
  packDarknonceUserOp,
  prepareDarknonceOperation,
  readDarknonceState,
  signDarknonceMessage,
  signDarknonceUserOp
} from '../../src/ambire-common/src/libs/darknonce/darknonce'
import type {
  DarknonceDeployment,
  DarknonceUserOperation
} from '../../src/ambire-common/src/libs/darknonce/types'
import EntryPointArtifact from '../../src/ambire-common/contracts/compiled/darknonce/EntryPoint.json'
import { startLocalRelay } from '../relay'

// Public BIP39 test vector. Never use this phrase for real funds.
const seed = 'test test test test test test test test test test test junk'
const provider = new JsonRpcProvider(process.env.RPC_URL || 'http://127.0.0.1:18545', undefined, {
  cacheTimeout: -1
})
let anvil: ChildProcess | undefined
let profile: DarknonceDeployment
let entryPoint: Contract
let safe: string
let funder: Awaited<ReturnType<JsonRpcProvider['getSigner']>>
let beneficiary: string
let reverter: string

before(async () => {
  if (!process.env.RPC_URL) {
    anvil = spawn(
      path.resolve(__dirname, '../node_modules/.bin/anvil'),
      ['--port', '18545', '--chain-id', '31337', '--silent'],
      { stdio: 'ignore' }
    )
    await new Promise<void>((resolve, reject) => {
      anvil!.once('error', reject)
      anvil!.once('spawn', resolve)
    })
    // The child shares this process's network namespace, including in managed environments.
    for (let attempt = 0; ; attempt++) {
      try {
        await provider.getNetwork()
        break
      } catch (error) {
        if (attempt >= 50) throw error
        await delay(50)
      }
    }
  }
  assert.equal(
    (await provider.getNetwork()).chainId,
    31337n,
    'Tests require a disposable Anvil chain'
  )
  funder = await provider.getSigner(0)
  beneficiary = await funder.getAddress()
  profile = await deployInfrastructure(funder)
  entryPoint = new Contract(profile.entryPoint, EntryPointArtifact.abi, funder)
  const creation = getDarknonceCreation(seed, profile, 0, '', 100)
  safe = creation.address
  await (await funder.sendTransaction(creation.call)).wait()
  await (await funder.sendTransaction({ to: safe, value: parseEther('5') })).wait()
  const contract = await new ContractFactory(
    [],
    '0x6005600c60003960056000f360006000fd',
    funder
  ).deploy()
  await contract.waitForDeployment()
  reverter = await contract.getAddress()
})
after(() => {
  provider.destroy()
  anvil?.kill()
})

async function operation(
  calls: { to: string; value: bigint; data: string }[] = [],
  rotateMessage = false
) {
  const state = await readDarknonceState(provider, safe, profile)
  const prepared = prepareDarknonceOperation(seed, profile, 0, state, calls, rotateMessage)
  const op: DarknonceUserOperation = {
    sender: safe,
    nonce: (await entryPoint.getFunction('getNonce')(safe, 0)).toString(),
    callData: prepared.callData,
    callGasLimit: '250000',
    verificationGasLimit: '400000',
    preVerificationGas: '80000',
    maxFeePerGas: '2000000000',
    maxPriorityFeePerGas: '1000000000',
    signature: '0x'
  }
  op.signature = await signDarknonceUserOp(op, profile, prepared.key)
  return { op, prepared, state }
}

async function submit(op: DarknonceUserOperation) {
  const receipt = await (
    await entryPoint.getFunction('handleOps')([packDarknonceUserOp(op)], beneficiary, {
      gasLimit: 2000000
    })
  ).wait()
  const event = receipt.logs
    .map((log: any) => {
      try {
        return entryPoint.interface.parseLog(log)
      } catch {
        return null
      }
    })
    .find((log: any) => log?.name === 'UserOperationEvent')
  assert.ok(event, 'EntryPoint emitted a receipt')
  return event.args
}

test('chain paths are hardened, deterministic and distinct even for uint256 chain IDs', () => {
  assert.ok(darknoncePath(31337n, 0, 'transaction').includes("/31337'/"))
  assert.notEqual(
    deriveDarknonceKey(seed, 1n, 0, 'transaction').address,
    deriveDarknonceKey(seed, 11155111n, 0, 'transaction').address
  )
  assert.notEqual(darknoncePath(1n << 31n, 0, 'transaction'), darknoncePath(1n, 0, 'transaction'))
  assert.doesNotThrow(() => darknoncePath((1n << 256n) - 1n, 0, 'message'))
  assert.throws(() => darknoncePath(1n << 256n, 0, 'transaction'))
})

test('BUG: invalid recovery phrase errors must not echo phrase text into wallet logs', () => {
  const invalidPhrase = 'this is an invalid public test phrase'
  for (const derive of [
    () => deriveDarknonceKey(invalidPhrase, 31337n, 0, 'transaction'),
    () => createDarknonceTree(invalidPhrase, 31337n, 0)
  ]) {
    assert.throws(derive, (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message.includes(invalidPhrase), false)
      assert.equal(error.cause, undefined)
      return true
    })
  }
})

test('seed recovery identifies the same Safe and all its current signer state', async () => {
  assert.equal(getDarknonceCreation(seed, profile, 0, '', 100).address, safe)
  const state = await readDarknonceState(provider, safe, profile)
  assert.equal(state.signer, deriveDarknonceKey(seed, 31337n, 0, 'transaction').address)
  assert.equal(
    await new Contract(safe, ['function VERSION() view returns(string)'], provider).getFunction(
      'VERSION'
    )(),
    '1.5.0'
  )
})

test('real EntryPoint execution rotates an unfunded owner and pays gas from the Safe', async () => {
  const recipient = Wallet.createRandom().address
  const { op, state, prepared } = await operation([{ to: recipient, value: 12345n, data: '0x' }])
  assert.equal(
    await entryPoint.getFunction('getUserOpHash')(packDarknonceUserOp(op)),
    hashDarknonceUserOp(op, profile)
  )
  const result = await submit(op)
  assert.equal(result.success, true)
  assert.equal(await provider.getBalance(recipient), 12345n)
  const next = await readDarknonceState(provider, safe, profile)
  assert.equal(next.signerEpoch, state.signerEpoch + 1n)
  assert.equal(next.signer, prepared.operation.nextSigner)
  assert.equal(await provider.getBalance(state.signer), 0n)
  assert.equal(await provider.getBalance(next.signer), 0n)
  const owners = await new Contract(
    safe,
    ['function getOwners() view returns(address[])'],
    provider
  ).getFunction('getOwners')()
  assert.deepEqual([...owners], [next.signer])
  assert.ok(result.actualGasCost > 0n)
})

test('application revert rolls back calls while retaining signer rotation and EntryPoint nonce', async () => {
  const recipient = Wallet.createRandom().address
  const { op, state } = await operation([
    { to: recipient, value: 1n, data: '0x' },
    { to: reverter, value: 0n, data: '0x' }
  ])
  const result = await submit(op)
  assert.equal(result.success, false)
  assert.equal(await provider.getBalance(recipient), 0n)
  assert.equal(
    (await readDarknonceState(provider, safe, profile)).signerEpoch,
    state.signerEpoch + 1n
  )
  assert.equal(await entryPoint.getFunction('getNonce')(safe, 0), BigInt(op.nonce) + 1n)
})

test('a separate ERC1271 message signer validates messages and expires after rotation', async () => {
  const state = await readDarknonceState(provider, safe, profile)
  const hash = hashMessage('Darknonce message')
  const signature = await signDarknonceMessage(hash, safe, profile, state, seed)
  const handler = new Contract(
    safe,
    ['function isValidSignature(bytes32,bytes) view returns(bytes4)'],
    provider
  )
  assert.equal(await handler.getFunction('isValidSignature')(hash, signature), '0x1626ba7e')
  const txKey = deriveDarknonceKey(seed, 31337n, 0, 'transaction', state.treeNumber, state.index)
  assert.equal(
    await handler.getFunction('isValidSignature')(
      hash,
      await txKey.signMessage('Darknonce message')
    ),
    '0xffffffff'
  )
  const { op } = await operation([], true)
  await submit(op)
  assert.equal(await handler.getFunction('isValidSignature')(hash, signature), '0xffffffff')
  const current = await readDarknonceState(provider, safe, profile)
  assert.equal(current.messageEpoch, state.messageEpoch + 1n)
  assert.equal(
    await handler.getFunction('isValidSignature')(
      hash,
      await signDarknonceMessage(hash, safe, profile, current, seed)
    ),
    '0x1626ba7e'
  )
})

test('invalid proofs and stale signatures cannot consume signer state', async () => {
  const { op, state, prepared } = await operation()
  prepared.operation.proof[0] = '0x' + '11'.repeat(32)
  const bad = {
    ...op,
    callData: darknonceModule.encodeFunctionData('execute', [prepared.operation])
  }
  await assert.rejects(() =>
    entryPoint.getFunction('handleOps').staticCall([packDarknonceUserOp(bad)], beneficiary)
  )
  assert.equal((await readDarknonceState(provider, safe, profile)).signerEpoch, state.signerEpoch)
  await submit(op)
  await assert.rejects(() =>
    entryPoint.getFunction('handleOps').staticCall([packDarknonceUserOp(op)], beneficiary)
  )
  assert.equal(
    (await readDarknonceState(provider, safe, profile)).signerEpoch,
    state.signerEpoch + 1n
  )
})

test('invalid signatures roll back validation rotation, including a signature from the message key', async () => {
  const { op, state } = await operation()
  const messageKey = deriveDarknonceKey(seed, 31337n, 0, 'message', 0, Number(state.messageEpoch))
  op.signature = await signDarknonceUserOp(op, profile, messageKey)
  await assert.rejects(() => submit(op))
  assert.equal((await readDarknonceState(provider, safe, profile)).signerEpoch, state.signerEpoch)
  assert.equal(await entryPoint.getFunction('getNonce')(safe, 0), BigInt(op.nonce))
})

test('Anvil JSON-RPC relay accepts fees from the Safe and returns a normal UserOperation receipt', async () => {
  const server = await startLocalRelay(provider, funder, profile, 0)
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const relay = new JsonRpcProvider(`http://127.0.0.1:${address.port}`, undefined, {
    cacheTimeout: -1
  })
  try {
    const { op } = await operation()
    assert.deepEqual(await relay.send('eth_supportedEntryPoints', []), [profile.entryPoint])
    const estimate = await relay.send('eth_estimateUserOperationGas', [op, profile.entryPoint])
    assert.equal(BigInt(estimate.verificationGasLimit), BigInt(op.verificationGasLimit))
    const hash = await relay.send('eth_sendUserOperation', [op, profile.entryPoint])
    const receipt = await relay.send('eth_getUserOperationReceipt', [hash])
    assert.equal(receipt.success, true)
    assert.equal(receipt.userOpHash, hashDarknonceUserOp(op, profile))
    assert.equal(receipt.receipt.status, '0x01')
  } finally {
    relay.destroy()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})

test('ordinary Safe execution and calls to account configuration cannot bypass rotation', async () => {
  const state = await readDarknonceState(provider, safe, profile)
  const direct = darknonceSafe.encodeFunctionData('execTransaction', [
    beneficiary,
    0,
    '0x',
    0,
    0,
    0,
    0,
    ZeroAddress,
    ZeroAddress,
    '0x'
  ])
  await assert.rejects(() => provider.call({ to: safe, data: direct }))
  const { op } = await operation([
    { to: safe, value: 0n, data: darknonceSafe.encodeFunctionData('setGuard', [ZeroAddress]) }
  ])
  assert.equal((await submit(op)).success, false)
  assert.equal(
    (await readDarknonceState(provider, safe, profile)).signerEpoch,
    state.signerEpoch + 1n
  )
})

test('wallet requires a renewal-only operation at 1% before signing an application', async () => {
  const state = await readDarknonceState(provider, safe, profile)
  assert.equal(needsDarknonceRenewal({ treeSize: 100, index: 98 }), false)
  assert.equal(needsDarknonceRenewal({ treeSize: 100, index: 99 }), true)
  assert.equal(needsDarknonceRenewal({ treeSize: 100, index: 100 }), false)
  // Renew to a small tree first: root rollover is intentionally authorized by the active signer.
  const tree = createDarknonceTree(seed, 31337n, 0, state.treeNumber + 1, 2)
  const { op, prepared } = await operation()
  prepared.operation.newRoot = tree.root
  prepared.operation.newTreeSize = 2
  prepared.operation.nextSigner = tree.addresses[0]!
  prepared.operation.proof = tree.proof(0)
  op.callData = darknonceModule.encodeFunctionData('execute', [prepared.operation])
  op.signature = await signDarknonceUserOp(op, profile, prepared.key)
  await submit(op)
  await submit((await operation()).op)
  const threshold = await readDarknonceState(provider, safe, profile)
  const renewal = prepareDarknonceOperation(seed, profile, 0, threshold, [
    { to: beneficiary, value: 1n, data: '0x' }
  ])
  assert.equal(renewal.renewing, true)
  assert.deepEqual(renewal.operation.calls, [])
  await submit((await operation()).op)
  const renewed = await readDarknonceState(provider, safe, profile)
  assert.equal(renewed.treeNumber, threshold.treeNumber + 1)
  assert.equal(renewed.index, 0)
  assert.equal(renewed.signerEpoch, threshold.signerEpoch + 1n)
})
