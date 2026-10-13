import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { JsonRpcProvider } from 'ethers'
import { deployInfrastructure } from './infrastructure'
import { startLocalRelay } from './relay'

/** One command starts Anvil, pinned infrastructure, and a reimbursed development relay. */
async function main() {
  const port = Number(process.env.ANVIL_PORT || 8545)
  const anvil = spawn(
    path.resolve(__dirname, 'node_modules/.bin/anvil'),
    ['--host', '0.0.0.0', '--port', port.toString(), '--chain-id', '31337', '--silent'],
    { stdio: 'inherit' }
  )
  const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, undefined, { cacheTimeout: -1 })
  let server: Awaited<ReturnType<typeof startLocalRelay>> | undefined
  const stop = () => {
    server?.close()
    provider.destroy()
    anvil.kill()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await provider.getNetwork()
        break
      } catch (error) {
        if (attempt >= 50) throw error
        await delay(50)
      }
    }
    const signer = await provider.getSigner(0)
    const profile = await deployInfrastructure(signer)
    await fs.mkdir(path.resolve(__dirname, 'deployments'), { recursive: true })
    await fs.writeFile(
      path.resolve(__dirname, 'deployments/31337.json'),
      JSON.stringify(profile, null, 2) + '\n'
    )
    server = await startLocalRelay(
      provider,
      signer,
      profile,
      Number(process.env.RELAY_PORT || 4337),
      process.env.RELAY_HOST || '127.0.0.1'
    )
    console.log(
      `Anvil: http://127.0.0.1:${port}; relay: http://127.0.0.1:${process.env.RELAY_PORT || 4337}`
    )
    console.log('Public deployment configuration: darknonce/deployments/31337.json')
    console.log(
      `Import Anvil account ${await signer.getAddress()} to pay deployment. Only use it on this disposable chain.`
    )
  } catch (error) {
    stop()
    throw error
  }
}
main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
