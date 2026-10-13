import React from 'react'
import { useTranslation } from '@common/config/localization'
import useNavigation from '@common/hooks/useNavigation'
import DarknonceForm from '@common/modules/darknonce/DarknonceForm'
import {
  MobileLayoutContainer,
  MobileLayoutWrapperMainContent
} from '@mobile/components/MobileLayoutWrapper'

const DarknonceScreen = () => {
  const { t } = useTranslation()
  const { goBack } = useNavigation()
  return (
    <MobileLayoutContainer>
      <MobileLayoutWrapperMainContent
        title={t('Darknonce')}
        withBackButton
        onBackButtonPress={goBack}
        withScroll
      >
        <DarknonceForm />
      </MobileLayoutWrapperMainContent>
    </MobileLayoutContainer>
  )
}
export default React.memo(DarknonceScreen)
