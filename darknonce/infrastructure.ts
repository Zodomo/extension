import { ContractFactory, type Signer } from 'ethers'
import Safe from '../src/ambire-common/contracts/compiled/darknonce/Safe.json'
import Factory from '../src/ambire-common/contracts/compiled/darknonce/SafeProxyFactory.json'
import EntryPoint from '../src/ambire-common/contracts/compiled/darknonce/EntryPoint.json'
import Batch from '../src/ambire-common/contracts/compiled/darknonce/DarknonceBatch.json'
import Module from '../src/ambire-common/contracts/compiled/darknonce/DarknonceModule.json'
import Guard from '../src/ambire-common/contracts/compiled/darknonce/DarknonceGuard.json'
import Setup from '../src/ambire-common/contracts/compiled/darknonce/DarknonceSetup.json'
import type { DarknonceDeployment } from '../src/ambire-common/src/libs/darknonce/types'

/** Deployment tooling only; the wallet never creates its own provider or deployer key. */
export async function deployInfrastructure(
  signer: Signer,
  existingEntryPoint?: string
): Promise<DarknonceDeployment> {
  async function deploy(artifact: { abi: any[]; bytecode: string }, args: unknown[] = []) {
    const contract = await new ContractFactory(artifact.abi, artifact.bytecode, signer).deploy(
      ...args
    )
    await contract.waitForDeployment()
    return contract
  }
  const singleton = await deploy(Safe)
  const factory = await deploy(Factory)
  const entryPoint = existingEntryPoint || (await (await deploy(EntryPoint)).getAddress())
  const batch = await deploy(Batch)
  const module = await deploy(Module, [entryPoint, await batch.getAddress()])
  const guard = await deploy(Guard)
  const setup = await deploy(Setup)
  return {
    version: 1,
    safeVersion: '1.5.0',
    entryPointVersion: '0.7.0',
    chainId: (await signer.provider!.getNetwork()).chainId.toString(),
    singleton: await singleton.getAddress(),
    factory: await factory.getAddress(),
    proxyCreationCode: await factory.getFunction('proxyCreationCode')(),
    entryPoint,
    module: await module.getAddress(),
    setup: await setup.getAddress(),
    guard: await guard.getAddress(),
    batch: await batch.getAddress()
  }
}
