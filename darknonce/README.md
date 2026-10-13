# Darknonce MVP

Darknonce is a new Ambire account type backed by a standard **Safe 1.5.0**, a Darknonce module, and **EntryPoint 0.7.0**. Transaction signing keys are unfunded and replaced on every accepted operation. The account keeps its address and pays transaction fees with its own ETH.

The implementation is on the `darknonce/poc` branches in [Zodomo/extension](https://github.com/Zodomo/extension/tree/darknonce/poc) and its [Zodomo/ambire-common](https://github.com/Zodomo/ambire-common/tree/darknonce/poc) submodule. The extension starts from upstream main `ce1c5b032b2cbceac8139d00cc908ed5db49dcaf`; the common code starts from the upstream submodule revision `56e1d01a2a27035e1a2b337bf054b48c078c7dd2`. The BIP39 fragment PR branch is separate and unchanged.

## Implemented scope

- A new dedicated recovery phrase, stored using Ambire's existing encrypted keystore. Deployment can be paid by an existing imported wallet, including a wallet unrelated to the new phrase. The factory call is permissionless and can also be submitted by any external wallet.
- Shared account creation, deployment review, recovery, ETH fee payment, transaction approval, and message signing logic for the extension and mobile app. Both platforms expose **Add account → Darknonce account**. Account menus expose **Darknonce settings**.
- A 1/1 Safe with a module/fallback handler and a guard that blocks ordinary Safe transactions from bypassing rotation. Application execution is an atomic batch of CALLs; direct Safe administration and arbitrary delegatecalls are excluded.
- Offchain Merkle trees, initially 1,024 transaction signers. At **10 or fewer remaining signers**, including the active signer, the wallet submits a renewal-only operation first. Once it confirms, the requested application batch is signed with the new list's first signer. The threshold is wallet policy; onchain, the active signer may authorize root replacement at any time.
- A distinct ERC-1271 message key. Its default policy is 10 transactions or 10 days; zero disables either limit. Rotation is included in the next transaction, or requested manually. Old signatures cease to validate after rotation. These signatures can authorize actions in applications that accept ERC-1271, including spending authorizations.
- Recovery from the dedicated phrase, its optional passphrase, account number, and public deployment configuration. Onchain state supplies the current tree, index, and message epoch. Account number defaults to zero. Device sync includes the phrase through Ambire's existing encrypted sync mechanism.

## Derivation and recovery

All path components are hardened:

```text
m/53560'/1'/<chain component count>'/<chain components>'/<account number>'/<role>'/<tree number>'/<index>'
```

The chain ID is encoded as big-endian 31-bit chunks, preceded by its chunk count. Ethereum, Sepolia, and Anvil therefore use their literal chain IDs as a single component. The roles are transaction `0`, message `1`, and account identity `2`. Message keys use tree number zero and the message epoch as their index.

The identity key connects the account to Ambire's phrase backup and sync screens. It is not a Safe owner, message signer, executor, or funded account. The Safe's CREATE2 address is derived from the initial configuration and an identity-key-based salt. Restore through the Darknonce screen rather than the ordinary Ethereum phrase import flow. Keep the public deployment JSON: infrastructure addresses and creation code are part of address recovery, so a phrase alone cannot identify a deployment made with unknown infrastructure. No signing history or executor key is needed.

## Local setup

Use Node 24 and Yarn 1.22.22, as required by Ambire. From the extension root:

```bash
yarn setup
cd darknonce
npm ci
npm run compile
npm test
npm run local
```

`local` starts Anvil on chain 31337, deploys the pinned infrastructure, starts a development relay, and writes `darknonce/deployments/31337.json`. Default addresses:

| Connection          | URL                     |
| ------------------- | ----------------------- |
| Blockchain          | `http://127.0.0.1:8545` |
| Transaction service | `http://127.0.0.1:4337` |

For a mobile device, use the computer's reachable address for both connections and set `RELAY_HOST=0.0.0.0` when starting `local`. Android emulators generally reach the host through `10.0.2.2`. The development relay is for a disposable Anvil chain and refuses other chain IDs. It validates real signed operations with EntryPoint and returns the supplied conservative gas bounds; it is not a production bundler or ERC-7562 trace validator.

To use the wallet:

1. Build and unlock Ambire with your existing development configuration. A normal extension build requires the root `.env` described in `.env-sample`; `scripts/validateEnv.js` enforces this. `IS_TESTING=true` is only for compile/E2E checks and waits for test storage initialization, so it is not a usable ordinary wallet build.
2. Import an Anvil-funded account to pay deployment. Anvil's public default test phrase is `test test test test test test test test test test test junk`. This phrase is only for the disposable chain. Darknonce generates a different, new phrase.
3. Open **Add account → Darknonce account**. Paste the generated deployment JSON, set the two connections, and select **Save network configuration**.
4. Select **Create with a new recovery phrase**. Back up that phrase using **Back up recovery phrase**.
5. Enter the funded account's address, choose the ETH funding amount, and select **Review deployment and funding**. Approve the ordinary Ambire request. Refresh after confirmation, then select **Open account**.
6. Send a small transfer normally. The Safe pays the fee, its owner changes, and both owner accounts remain unfunded. The Safe address stays the same.
7. To test recovery, use a fresh Ambire profile and **Restore Darknonce** with the same public configuration, phrase, passphrase if used, and account number.

Supported build commands from the extension root:

```bash
yarn build:web:webkit:generate-policy
yarn build:webview
```

The first command builds the desktop extension and regenerates its LavaMoat policy. Load the resulting `build/webkit-prod` directory as an unpacked extension. The second builds the shared mobile worker; use Ambire's normal `yarn android` / `yarn ios` flows for native app testing. Mobile UI code is shared, with platform layout wrappers.

## Sepolia handoff

Sepolia execution has not been performed in this environment. After local testing:

1. Use a Sepolia-funded deployer to deploy infrastructure. Set `RPC_URL` and `DEPLOYER_PRIVATE_KEY` in your local shell, then run `npm run deploy` from `darknonce`. Do not put a deployer secret into the deployment JSON or commit it. The script uses canonical EntryPoint v0.7 at `0x0000000071727De22E5E9d8BAf0edAc6f37da032` by default and writes `deployments/11155111.json`.
2. Obtain a Sepolia bundler endpoint that supports EntryPoint v0.7 and accepts this custom Safe module's validation. Public providers may apply additional tracing, staking, or allowlist requirements; acceptance has not been tested. The local development relay cannot be used on Sepolia.
3. Paste the Sepolia deployment JSON and your RPC/bundler URLs into the Darknonce screen. Configure the network and create a new account, or use the same dedicated phrase with the Sepolia account number through the SDK. The chain-specific path produces separate signing keys and a separate Safe address.
4. Deploy and fund the Safe from an imported Sepolia-funded wallet, then test small transfers, messages, manual message rotation, and phrase recovery.

The wallet's restore button requires an existing deployment. The creation controller always generates a new phrase; the SDK can derive another chain's deployment from an existing dedicated phrase. A full cross-chain account-creation UI is outside this MVP.

## Verification and remaining limits

Current checks: **17 Anvil tests passed**. Extension and tooling TypeScript checks report **zero new errors against Ambire's baseline**, and the new Darknonce wallet files pass ESLint. Desktop production compilation, LavaMoat policy generation, the shared mobile worker build, and Android UI JavaScript export passed. Policy regeneration produced no permission changes. Desktop compilation used E2E mode because the normal Ambire `.env` is absent; that output is not a usable ordinary wallet build. Native device execution remains untested.

The Anvil tests use real Safe and EntryPoint bytecode and cover derivation separation, deterministic recovery, gas payment, successful calls, atomic application reverts, rejected proofs/signatures, native-execution bypass rejection, ERC-1271 message rotation, root renewal, encrypted wallet registration, deployment from an unrelated wallet, the Ambire transaction approval/broadcast flow, and recovery in a fresh keystore. Invalid-phrase errors are sanitized so phrase text is not passed into Ambire's controller logs.

Transaction rotation occurs during EntryPoint validation, before application execution. An inner application revert rolls back application effects but preserves the replacement owner, signer epoch, and EntryPoint nonce. An outer EntryPoint transaction revert rolls back everything, so public-key exposure can remain after an operation fails before inclusion or causes an outer revert. This MVP implements the agreed best effort behavior; it does not make public-key exposure zero during transaction propagation.

The MVP does not protect against compromised phrases or private keys. It has no executor-key lifecycle, paymaster integration, gas-token payments, EIP-7702 delegation, hardware storage for the dedicated seed, or onchain renewal timing restrictions. ETH funding must cover application value and fees; renewal requires fees for two operations. Phrase recovery starts a fresh local message-policy baseline; use manual message rotation if needed. Native device runtime testing and a usable desktop build await the normal Ambire configuration. Use this PoC for local/testnet experiments.
