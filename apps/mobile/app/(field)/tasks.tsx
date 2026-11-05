import { api } from '../../src/lib/api';
import { useI18n } from '../../src/lib/i18n';
import { useQuery } from '../../src/lib/useQuery';
import { Button, Card, Screen, T } from '../../src/components/ui';

/** Coordinator inbox: automation-created tasks (missed doses, no-shows, no contact, concerns, replacements) + unread chats. */
export default function Tasks() {
  const { lang } = useI18n();
  const q = useQuery<{ items: any[] }>('/field/tasks', 30_000);
  const chats = useQuery<{ items: any[] }>('/field/chats', 30_000);
  return (
    <Screen>
      {q.data?.items.map((x) => (
        <Card key={x.id}>
          <T kind="bold">{x.kind}</T><T>{x.title}</T>
          {x.due_at && <T size="sm">◷ {new Date(x.due_at).toLocaleString(lang === 'ar' ? 'ar-EG' : 'en-GB', { timeZone: 'Africa/Cairo' })}</T>}
          <Button variant="secondary" title="✓" onPress={() => api(`/tasks/${x.id}/done`, { method: 'POST' }).then(q.reload)} />
        </Card>
      ))}
      {chats.data?.items.filter((c) => c.unread > 0).map((c) => <Card key={c.parent_id} tone="sand"><T kind="bold">✉ {c.name}: {c.unread}</T></Card>)}
    </Screen>
  );
}
