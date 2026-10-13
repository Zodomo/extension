import http from 'node:http'
import fs from 'node:fs/promises'
import { Contract, JsonRpcProvider, toBeHex, type Signer } from 'ethers'
import EntryPointArtifact from '../src/ambire-common/contracts/compiled/darknonce/EntryPoint.json'
import {
  hashDarknonceUserOp,
  packDarknonceUserOp
} from '../src/ambire-common/src/libs/darknonce/darknonce'
import type {
  DarknonceDeployment,
  DarknonceUserOperation
} from '../src/ambire-common/src/libs/darknonce/types'

/** Anvil-only relay. It validates bounded operations against the real EntryPoint. */
export async function startLocalRelay(
  provider: JsonRpcProvider,
  signer: Signer,
  profile: DarknonceDeployment,
  port = 4337,
  host = '127.0.0.1'
) {
  if ((await provider.getNetwork()).chainId !== 31337n || profile.chainId !== '31337')
    throw new Error('The development relay only accepts a disposable Anvil chain.')
  const entryPoint = new Contract(profile.entryPoint, EntryPointArtifact.abi, signer)
  const beneficiary = await signer.getAddress()
  const receipts = new Map<string, unknown>()
  let queue: Promise<unknown> = Promise.resolve()

  async function dispatch(method: string, params: any[]) {
    if (method === 'eth_supportedEntryPoints') return [profile.entryPoint]
    if (method === 'eth_getUserOperationReceipt') return receipts.get(params[0]) || null
    if (method === 'eth_estimateUserOperationGas' || method === 'eth_sendUserOperation') {
      if (params[1]?.toLowerCase() !== profile.entryPoint.toLowerCase())
        throw new Error('Unsupported EntryPoint')
      const op: DarknonceUserOperation = params[0]
      if (BigInt(op.verificationGasLimit) > 500000n || BigInt(op.callGasLimit) > 15000000n)
        throw new Error('Operation exceeds development relay limits')
      const packed = packDarknonceUserOp(op)
      await entryPoint
        .getFunction('handleOps')
        .staticCall([packed], beneficiary, {
          gasLimit: BigInt(op.callGasLimit) + BigInt(op.verificationGasLimit) + 300000n
        })
      if (method === 'eth_estimateUserOperationGas') {
        return {
          callGasLimit: toBeHex(BigInt(op.callGasLimit)),
          verificationGasLimit: toBeHex(BigInt(op.verificationGasLimit)),
          preVerificationGas: toBeHex(BigInt(op.preVerificationGas)),
          paymasterVerificationGasLimit: '0x0',
          paymasterPostOpGasLimit: '0x0'
        }
      }
      const hash = hashDarknonceUserOp(op, profile)
      const receipt = await (
        await entryPoint.getFunction('handleOps')([packed], beneficiary, {
          gasLimit: BigInt(op.callGasLimit) + BigInt(op.verificationGasLimit) + 300000n
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
        .find((event: any) => event?.name === 'UserOperationEvent')
      if (!event) throw new Error('EntryPoint did not emit a UserOperation receipt')
      receipts.set(hash, {
        userOpHash: hash,
        sender: op.sender,
        nonce: op.nonce,
        success: event.args.success,
        actualGasCost: toBeHex(event.args.actualGasCost),
        actualGasUsed: toBeHex(event.args.actualGasUsed),
        logs: receipt.logs,
        receipt: {
          ...receipt.toJSON(),
          transactionHash: receipt.hash,
          status: toBeHex(receipt.status),
          blockNumber: toBeHex(receipt.blockNumber),
          gasUsed: toBeHex(receipt.gasUsed)
        }
      })
      return hash
    }
    // Allow ethers/viem network detection and gas-price requests through the same endpoint.
    if (
      [
        'eth_chainId',
        'eth_blockNumber',
        'eth_gasPrice',
        'eth_maxPriorityFeePerGas',
        'eth_getBlockByNumber',
        'eth_feeHistory'
      ].includes(method)
    )
      return provider.send(method, params)
    throw new Error(`Unsupported development method: ${method}`)
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }
    try {
      let body = ''
      for await (const chunk of request) {
        body += chunk.toString()
        if (body.length > 2000000) throw new Error('Request too large')
      }
      const input = JSON.parse(body)
      async function handle(item: { id: unknown; method: string; params?: any[] }) {
        try {
          const run = () => dispatch(item.method, item.params || [])
          const pending = item.method === 'eth_sendUserOperation' ? queue.then(run, run) : run()
          if (item.method === 'eth_sendUserOperation') queue = pending.catch(() => undefined)
          return { jsonrpc: '2.0', id: item.id, result: await pending }
        } catch (error) {
          return {
            jsonrpc: '2.0',
            id: item.id,
            error: {
              code: -32500,
              message: error instanceof Error ? error.message : 'Relay request failed'
            }
          }
        }
      }
      const output = Array.isArray(input)
        ? await Promise.all(input.map(handle))
        : await handle(input)
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(output))
    } catch {
      response.writeHead(400)
      response.end('Invalid JSON-RPC request')
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  return server
}

async function main() {
  const provider = new JsonRpcProvider(process.env.RPC_URL || 'http://127.0.0.1:8545', undefined, {
    cacheTimeout: -1
  })
  const profile = JSON.parse(
    await fs.readFile(process.env.DEPLOYMENT_FILE || 'deployments/31337.json', 'utf8')
  )
  await startLocalRelay(
    provider,
    await provider.getSigner(0),
    profile,
    Number(process.env.RELAY_PORT || 4337),
    process.env.RELAY_HOST || '127.0.0.1'
  )
  console.log(`Anvil relay listening on port ${process.env.RELAY_PORT || 4337}`)
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
