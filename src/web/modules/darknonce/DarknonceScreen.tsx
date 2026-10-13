import React from 'react'
import Panel from '@common/components/Panel'
import { useTranslation } from '@common/config/localization'
import useNavigation from '@common/hooks/useNavigation'
import useTheme from '@common/hooks/useTheme'
import DarknonceForm from '@common/modules/darknonce/DarknonceForm'
import {
  TabLayoutContainer,
  TabLayoutWrapperMainContent
} from '@web/components/TabLayoutWrapper/TabLayoutWrapper'

const DarknonceScreen = () => {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const { goBack } = useNavigation()
  return (
    <TabLayoutContainer backgroundColor={theme.secondaryBackground}>
      <TabLayoutWrapperMainContent>
        <Panel title={t('Darknonce')} type="onboarding" withBackButton onBackButtonPress={goBack}>
          <DarknonceForm />
        </Panel>
      </TabLayoutWrapperMainContent>
    </TabLayoutContainer>
  )
}
export default React.memo(DarknonceScreen)
