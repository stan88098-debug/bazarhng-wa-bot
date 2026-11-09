export const LANGS = ['en', 'pcm', 'yo', 'ig', 'ha'];

// Fixed system messages only. Every normal reply is written by the AI in the vendor's own language.
const M = {
  en: {
    inactive: 'Your store is not active right now. Please contact BazarhNG support.',
    error: 'Something went wrong on my side. Please try again in a moment.',
    rateLimited: 'You are sending messages too fast. Please wait a minute and try again.',
    dailyLimit: 'You have reached today\'s message limit. Please try again tomorrow, or use your dashboard for now.',
    aiDown: 'My brain is a bit slow right now. Please send that again in a moment.',
    voiceFail: 'I could not understand that voice note. Please try again or type it.',
    voiceTooLong: 'That voice note is too long. Please keep it under 2 minutes or type it.',
  },
  pcm: {
    inactive: 'Your store no active now. Abeg contact BazarhNG support.',
    error: 'Wahala dey my side. Abeg try again small time.',
    rateLimited: 'You dey send message too fast. Abeg wait small and try again.',
    dailyLimit: 'You don reach the message limit for today. Abeg try again tomorrow, or use your dashboard for now.',
    aiDown: 'My head no dey work well now. Abeg send am again small time.',
    voiceFail: 'I no fit hear that voice note well. Abeg try again or type am.',
    voiceTooLong: 'That voice note too long. Abeg make am no pass 2 minutes or type am.',
  },
  yo: {
    inactive: 'Ṣọ́ọ̀bù rẹ kò ṣiṣẹ́ lọ́wọ́lọ́wọ́. Jọ̀wọ́ kàn sí ìrànlọ́wọ́ BazarhNG.',
    error: 'Ìṣòro kan ṣẹlẹ̀ ní ìhà mi. Jọ̀wọ́ tún gbìyànjú láìpẹ́.',
    rateLimited: 'O ń fi ìfiránṣẹ́ ránṣẹ́ yára jù. Jọ̀wọ́ dúró ìṣẹ́jú kan kí o tún gbìyànjú.',
    dailyLimit: 'O ti dé òpin ìfiránṣẹ́ òní. Jọ̀wọ́ tún gbìyànjú lọ́la, tàbí lo dashboard rẹ lọ́wọ́lọ́wọ́.',
    aiDown: 'Ọpọlọ mi ń lọ́ra díẹ̀ báyìí. Jọ̀wọ́ tún fi ránṣẹ́ láìpẹ́.',
    voiceFail: 'Mi ò lè gbọ́ ohùn yẹn dáadáa. Jọ̀wọ́ tún gbìyànjú tàbí kọ ọ́ sílẹ̀.',
    voiceTooLong: 'Ohùn yẹn gùn jù. Jọ̀wọ́ jẹ́ kó dín ní ìṣẹ́jú méjì tàbí kọ ọ́ sílẹ̀.',
  },
  ig: {
    inactive: 'Ụlọ ahịa gị anaghị arụ ọrụ ugbu a. Biko kpọtụrụ nkwado BazarhNG.',
    error: 'Nsogbu mere n’akụkụ m. Biko nwaa ọzọ n’oge na-adịghị anya.',
    rateLimited: 'Ị na-ezipụ ozi ngwa ngwa nke ukwuu. Biko chere nkeji ole na ole ma nwaa ọzọ.',
    dailyLimit: 'Ị ruola oke ozi nke taa. Biko nwaa ọzọ echi, ma ọ bụ jiri dashboard gị ugbu a.',
    aiDown: 'Uche m na-aga nwayọọ ugbu a. Biko zipu ya ọzọ n’oge na-adịghị anya.',
    voiceFail: 'Enweghị m ike ịghọta ụda ahụ. Biko nwaa ọzọ ma ọ bụ dee ya.',
    voiceTooLong: 'Ụda ahụ dị ogologo nke ukwuu. Biko mee ya ka o nwee ihe na-erughị nkeji abụọ ma ọ bụ dee ya.',
  },
  ha: {
    inactive: 'Shagonka ba ya aiki a yanzu. Tuntuɓi tallafin BazarhNG.',
    error: 'Matsala ta faru a nawa ɓangaren. Da fatan za a sake gwadawa nan gaba kaɗan.',
    rateLimited: 'Kana aika saƙonni da sauri sosai. Da fatan ka jira ɗan lokaci ka sake gwadawa.',
    dailyLimit: 'Ka kai iyakar saƙonnin yau. Da fatan ka sake gwadawa gobe, ko ka yi amfani da dashboard ɗinka yanzu.',
    aiDown: 'Kwakwalwata tana ɗan jinkiri yanzu. Da fatan za a sake aikawa nan gaba kaɗan.',
    voiceFail: 'Ban fahimci wannan saƙon murya ba. Da fatan ka sake gwadawa ko ka rubuta shi.',
    voiceTooLong: 'Wannan saƙon murya ya yi tsayi. Da fatan ka rage shi ƙasa da mintuna 2 ko ka rubuta shi.',
  },
};

export function t(lang, key, vars = {}) {
  const s = (M[lang] || M.en)[key] ?? M.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}
