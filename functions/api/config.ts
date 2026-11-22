import { Env, Handler, json } from "./_lib";

/** إعدادات عامة للواجهة: اسم بوت تيليجرام متى وُجد */
export const onRequestGet: Handler = async ({ env }) => {
  return json({ telegram_bot: env.TELEGRAM_BOT || null });
};
