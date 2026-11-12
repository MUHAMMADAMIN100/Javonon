import { INTERACTION_ICON, INTERACTION_LABEL, type Interaction, type InteractionType, type TimelineItem } from '../api/interactions';

/** Подпись, значок и вид записи ленты (ручная запись, звонок с телефонии, переписка). */
export type TimelineKind = 'call' | 'message' | 'meeting' | 'note';

export function timelineVisuals(it: Interaction | TimelineItem, t: (k: string) => string): { label: string; icon: string; kind: TimelineKind } {
  const source = (it as TimelineItem).source;
  if (source === 'call') {
    return { label: (it as TimelineItem).direction === 'INCOMING' || (it as TimelineItem).direction === 'IN' ? t('interactions.call.in') : t('interactions.call.out'), icon: 'call', kind: 'call' };
  }
  if (source === 'message') {
    const item = it as TimelineItem;
    const names: Record<string, string> = { WHATSAPP: 'WhatsApp', INSTAGRAM: 'Instagram', TELEGRAM: 'Telegram', SMS: 'SMS' };
    return {
      label: `${names[item.channel || ''] || item.channel || ''} ${item.direction === 'IN' ? t('interactions.from') : t('interactions.to')}`.trim(),
      icon: item.channel === 'INSTAGRAM' ? 'photo_camera' : item.channel === 'SMS' ? 'sms' : 'chat_bubble',
      kind: 'message',
    };
  }
  const type = (it as Interaction).type as InteractionType | undefined;
  const kind: TimelineKind = type === 'CALL' ? 'call' : type === 'MEETING' ? 'meeting' : type === 'NOTE' ? 'note' : 'message';
  return { label: type ? INTERACTION_LABEL[type] || type : t('interactions.entry'), icon: type ? INTERACTION_ICON[type] || 'chat' : 'chat', kind };
}
