import messages from '@proj-airi/i18n/locales'

import { resolveSupportedLocale } from '@proj-airi/i18n'
import { createI18n } from 'vue-i18n'

<<<<<<< HEAD
const languageRemap: Record<string, string> = {
  'zh-CN': 'zh-Hans',
  'zh-TW': 'zh-Hant',
  'zh-HK': 'zh-Hant',
  'zh-Hant': 'zh-Hant',
  'en-US': 'en',
  'en-GB': 'en',
  'en-AU': 'en',
  'en': 'en',
  'es-ES': 'es',
  'es-MX': 'es',
  'es-AR': 'es',
  'es': 'es',
  'vi': 'vi',
  'vi-VN': 'vi',
  'ru': 'ru',
  'ru-RU': 'ru',
  'fr': 'fr',
  'fr-FR': 'fr',
}

=======
>>>>>>> 589df9aff0e3a771c0354b00e10ce111314e1768
function getLocale() {
  let language = localStorage.getItem('settings/language')

  if (!language) {
    // Fallback to browser language
    language = navigator.language || 'zh-TW'
  }

<<<<<<< HEAD
  const languages = Object.keys(messages!)
  if (languageRemap[language || 'zh-TW'] != null) {
    language = languageRemap[language || 'zh-TW']
  }
  if (language && languages.includes(language))
    return language

  return 'zh-Hant'
=======
  return resolveSupportedLocale(language, Object.keys(messages!))
>>>>>>> 589df9aff0e3a771c0354b00e10ce111314e1768
}

export const i18n = createI18n({
  legacy: false,
  locale: getLocale(),
  fallbackLocale: 'zh-Hant',
  messages,
})
