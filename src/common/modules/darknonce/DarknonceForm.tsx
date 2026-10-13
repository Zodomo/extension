import React, { useCallback, useMemo, useState } from 'react'
import { View } from 'react-native'
import type { AllControllersMappingType } from '@common/constants/controllersMapping'
import Button from '@common/components/Button'
import Input from '@common/components/Input'
import Text from '@common/components/Text'
import { useTranslation } from '@common/config/localization'
import useController from '@common/hooks/useController'
import useNavigation from '@common/hooks/useNavigation'
import useTheme from '@common/hooks/useTheme'
import useToast from '@common/hooks/useToast'
import { ROUTES } from '@common/modules/router/constants/common'
import spacings from '@common/styles/spacings'
import flexbox from '@common/styles/utils/flexbox'

const selectDarknonce = (state: AllControllersMappingType['DarknonceController']) => ({
  accountAddr: state.accountAddr,
  chainId: state.chainId,
  state: state.state,
  statuses: state.statuses,
  messagePolicy: state.messagePolicy
})

/** Shared PoC flow; wrappers supply extension or mobile layout and navigation. */
const DarknonceForm = () => {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const { addToast } = useToast()
  const { navigate } = useNavigation()
  const { state, dispatch } = useController('DarknonceController', selectDarknonce)
  const { state: selected } = useController('SelectedAccountController', 'account')
  const { state: accounts } = useController('AccountsController', 'accounts')
  const { dispatch: networksDispatch, state: networkStatuses } = useController(
    'NetworksController',
    'statuses'
  )
  const { dispatch: mainDispatch } = useController('MainController', 'statuses')
  const [profile, setProfile] = useState(() =>
    selected?.darknonce ? JSON.stringify(selected.darknonce.deployment, null, 2) : ''
  )
  const [rpc, setRpc] = useState('http://127.0.0.1:8545')
  const [relay, setRelay] = useState('http://127.0.0.1:4337')
  const [phrase, setPhrase] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [accountNumber, setAccountNumber] = useState('0')
  const [fundingAccount, setFundingAccount] = useState(
    selected?.darknonce ? '' : selected?.addr || ''
  )
  const [funding, setFunding] = useState('0.01')
  const [transactionDraft, setTransactions] = useState<string>()
  const [daysDraft, setDays] = useState<string>()
  const transactions = transactionDraft ?? state.messagePolicy.transactions.toString()
  const days = daysDraft ?? state.messagePolicy.days.toString()
  const isBusy = useMemo(() => Object.values(state.statuses).includes('LOADING'), [state.statuses])
  const currentAccount = useMemo(
    () => accounts.find((account) => account.addr === state.accountAddr),
    [accounts, state.accountAddr]
  )

  const configure = useCallback(() => {
    try {
      const configuration = JSON.parse(profile)
      if (typeof configuration.chainId !== 'string') throw new Error('Missing network ID')
      networksDispatch({
        type: 'method',
        params: { method: 'configureDarknonceNetwork', args: [configuration.chainId, rpc, relay] }
      })
    } catch {
      addToast(t('Paste a valid Darknonce deployment configuration.'), { type: 'error' })
    }
  }, [profile, rpc, relay, networksDispatch, addToast, t])
  const create = useCallback(
    () =>
      dispatch({
        type: 'method',
        params: { method: 'create', args: [profile, Number(accountNumber)] }
      }),
    [dispatch, profile, accountNumber]
  )
  const restore = useCallback(() => {
    dispatch({
      type: 'method',
      params: { method: 'restore', args: [profile, phrase, passphrase, Number(accountNumber)] }
    })
    setPhrase('')
    setPassphrase('')
  }, [dispatch, profile, phrase, passphrase, accountNumber])
  const deploy = useCallback(
    () =>
      dispatch({ type: 'method', params: { method: 'deploy', args: [fundingAccount, funding] } }),
    [dispatch, fundingAccount, funding]
  )
  const refresh = useCallback(
    () =>
      state.accountAddr &&
      dispatch({ type: 'method', params: { method: 'inspect', args: [state.accountAddr] } }),
    [dispatch, state.accountAddr]
  )
  const savePolicy = useCallback(
    () =>
      state.accountAddr &&
      dispatch({
        type: 'method',
        params: {
          method: 'updatePolicy',
          args: [state.accountAddr, Number(transactions), Number(days)]
        }
      }),
    [dispatch, state.accountAddr, transactions, days]
  )
  const rotate = useCallback(
    () =>
      state.accountAddr &&
      dispatch({
        type: 'method',
        params: {
          method: 'updatePolicy',
          args: [state.accountAddr, Number(transactions), Number(days), true]
        }
      }),
    [dispatch, state.accountAddr, transactions, days]
  )
  const openAccount = useCallback(() => {
    if (!state.accountAddr) return
    mainDispatch({ type: 'method', params: { method: 'selectAccount', args: [state.accountAddr] } })
    navigate(ROUTES.dashboard)
  }, [mainDispatch, navigate, state.accountAddr])
  const backup = useCallback(() => navigate(ROUTES.recoveryPhrasesSettings), [navigate])
  const startAgain = useCallback(() => {
    setTransactions(undefined)
    setDays(undefined)
    dispatch({ type: 'method', params: { method: 'reset', args: [] } })
  }, [dispatch])

  return (
    <View style={flexbox.flex1}>
      <Text style={spacings.mb}>
        {t(
          'Darknonce keeps one wallet address and changes its transaction signing key after every operation.'
        )}
      </Text>
      {!state.accountAddr ? (
        <>
          <Input
            label={t('Deployment configuration')}
            value={profile}
            onChangeText={setProfile}
            multiline
            autoCorrect={false}
            autoCapitalize="none"
            testID="darknonce-profile"
          />
          <Input
            label={t('Network connection')}
            value={rpc}
            onChangeText={setRpc}
            autoCorrect={false}
            autoCapitalize="none"
          />
          <Input
            label={t('Transaction service')}
            value={relay}
            onChangeText={setRelay}
            autoCorrect={false}
            autoCapitalize="none"
          />
          <Button
            text={t('Save network configuration')}
            onPress={configure}
            disabled={networkStatuses.addNetwork !== 'INITIAL' || !profile}
          />
          <Input
            label={t('Account number (starts at 0)')}
            value={accountNumber}
            onChangeText={setAccountNumber}
            keyboardType="numeric"
          />
          <Button
            text={t('Create with a new recovery phrase')}
            onPress={create}
            disabled={isBusy || !profile}
            testID="darknonce-create"
          />
          <Text style={spacings.mb}>{t('Or restore a deployed Darknonce account:')}</Text>
          <Input
            label={t('Darknonce recovery phrase')}
            value={phrase}
            onChangeText={setPhrase}
            secureTextEntry
            autoCorrect={false}
            autoCapitalize="none"
            testID="darknonce-phrase"
          />
          <Input
            label={t('Recovery phrase passphrase (optional)')}
            value={passphrase}
            onChangeText={setPassphrase}
            secureTextEntry
            autoCorrect={false}
            autoCapitalize="none"
          />
          <Button
            text={t('Restore Darknonce')}
            onPress={restore}
            disabled={isBusy || !phrase || !profile}
            testID="darknonce-restore"
          />
        </>
      ) : (
        <>
          <Text selectable style={spacings.mb}>
            {state.accountAddr}
          </Text>
          <Text style={spacings.mb}>
            {state.state
              ? t('Deployed on network {{chain}}. Signing key {{epoch}}.', {
                  chain: state.chainId,
                  epoch: state.state.signerEpoch.toString()
                })
              : t('Ready to deploy on network {{chain}}.', { chain: state.chainId })}
          </Text>
          <Text style={spacings.mb}>
            {t(
              'Your separate Darknonce phrase is saved in this wallet. Back it up before funding this account.'
            )}
          </Text>
          <Button text={t('Back up recovery phrase')} type="secondary" onPress={backup} />
          {!state.state && (
            <>
              <Input
                label={t('Existing account to pay deployment')}
                value={fundingAccount}
                onChangeText={setFundingAccount}
                autoCorrect={false}
                autoCapitalize="none"
              />
              <Input
                label={t('ETH to fund the new account')}
                value={funding}
                onChangeText={setFunding}
                keyboardType="decimal-pad"
              />
              <Button
                text={t('Review deployment and funding')}
                onPress={deploy}
                disabled={isBusy || !fundingAccount}
                testID="darknonce-deploy"
              />
              <Text style={spacings.mb}>
                {t('After the deployment confirms, refresh this account.')}
              </Text>
            </>
          )}
          <Button
            text={t('Refresh account')}
            type="secondary"
            onPress={refresh}
            disabled={isBusy}
          />
          <Text style={[spacings.mb, { color: theme.primaryText }]}>
            {t(
              'Message signing key: rotate on your next transaction after either limit. Use 0 to disable a limit.'
            )}
          </Text>
          <Input
            label={t('Transactions between message key changes')}
            value={transactions}
            onChangeText={setTransactions}
            keyboardType="numeric"
          />
          <Input
            label={t('Days between message key changes')}
            value={days}
            onChangeText={setDays}
            keyboardType="numeric"
          />
          <Button text={t('Save message policy')} onPress={savePolicy} disabled={isBusy} />
          {state.state && (
            <Button
              text={t('Review a message key change now')}
              type="secondary"
              onPress={rotate}
              disabled={isBusy}
            />
          )}
          <Button
            text={t('Open account')}
            onPress={openAccount}
            disabled={!currentAccount || !state.state}
          />
          <Button
            text={t('Create or restore another account')}
            type="secondary"
            onPress={startAgain}
            disabled={isBusy}
          />
        </>
      )}
      {isBusy && <Text>{t('Preparing your account…')}</Text>}
    </View>
  )
}

export default React.memo(DarknonceForm)
