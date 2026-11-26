// Read source listing metadata independently; this does not run the discovery engine.
for (const channel of ['IdlebUniversity', 'SyMOHEASR']) {
  const response = await fetch(`https://t.me/s/${channel}`, {signal: AbortSignal.timeout(10000)});
  if (!response.ok) throw new Error(`${channel}: HTTP ${response.status}`);
  const html = await response.text();
  for (const block of html.split('tgme_widget_message_wrap').slice(1)) {
    const id = block.match(/data-post="([^"]+)/)?.[1];
    const date = block.match(/datetime="([^"]+)/)?.[1];
    const raw = block.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/)?.[1];
    if (id && date && raw) console.log(JSON.stringify({id, date, text:raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 240)}));
  }
}
const rss=await fetch('https://sana.sy/governorates/edlib/feed/',{signal:AbortSignal.timeout(10000)});
if(!rss.ok)throw new Error(`SANA feed: HTTP ${rss.status}`);
for(const item of (await rss.text()).split('<item>').slice(1)) {
 const link=item.match(/<link>([^<]+)<\/link>/)?.[1];
 const title=item.match(/<title>([\s\S]*?)<\/title>/)?.[1];
 if(link&&title)console.log(JSON.stringify({source:'sana-feed',link,title:title.replace(/<!\[CDATA\[|\]\]>/g,'')}));
}
