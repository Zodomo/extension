import fs from 'node:fs/promises'
import path from 'node:path'
import { JsonRpcProvider, NonceManager, Wallet } from 'ethers'
import { deployInfrastructure } from './infrastructure'

async function main() {
  const rpc = process.env.RPC_URL || 'http://127.0.0.1:8545'
  const provider = new JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 })
  const network = await provider.getNetwork()
  if (network.chainId !== 31337n && !process.env.DEPLOYER_PRIVATE_KEY) {
    throw new Error('For a testnet deployment, set DEPLOYER_PRIVATE_KEY in your local environment.')
  }
  const signer = new NonceManager(
    process.env.DEPLOYER_PRIVATE_KEY
      ? new Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider)
      : await provider.getSigner(0)
  )
  const canonicalEntryPoint = '0x0000000071727De22E5E9d8BAf0edAc6f37da032'
  const profile = await deployInfrastructure(
    signer,
    process.env.ENTRY_POINT || (network.chainId === 31337n ? undefined : canonicalEntryPoint)
  )
  const output = process.env.DEPLOYMENT_FILE || `deployments/${profile.chainId}.json`
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, JSON.stringify(profile, null, 2) + '\n')
  console.log(`Safe ${profile.safeVersion} / EntryPoint ${profile.entryPointVersion}: ${output}`)
  console.log(`Darknonce module: ${profile.module}`)
  provider.destroy()
}
main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
