import { createEvent, EventInput } from '../../tests/helpers/db';
import { runPhp } from '../../tests/helpers/container';

/**
 * Create an event and announce it, the way saving it as Live from the form does.
 *
 * On the forum an event *is* its announcement thread: the event card sits in place of the
 * first post, under the thread's title and its Post Reply buttons, and event.php sends
 * people there. An event created straight into the database has no thread, so event.php
 * shows the bare card instead - which is not a page any member ever sees. Pending events
 * aren't announced, so create those with createEvent().
 */
export async function createAnnouncedEvent(input: EventInput): Promise<number> {
  const eventId = await createEvent(input);
  const output = await runPhp(`
require_once MYBB_ROOT.'inc/plugins/events/inc/events_thread.php';
echo events_sync_event_thread(${eventId});
`);

  if (!(Number(output.trim()) > 0)) {
    throw new Error(`Event ${eventId} was not announced: ${output}`);
  }

  return eventId;
}
