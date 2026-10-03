# MyBB Event Management Plugin

A comprehensive event management plugin for MyBB 1.8 that replaces thread-based event signups with a structured system featuring signup tracking, prerequisite validation, multi-day event support, attendance sheets, and automated troop report generation.

## Features

- **Event Management**: Create, edit, and manage events with status (pending/live/archived),
  from the Admin CP or from the front end by a coordinator with no Admin CP access
- **Multi-day Events**: Support for events spanning multiple days
- **Signup System**: One "Sign Up to Attend" flow with prerequisite validation
- **Per-day Roles**: Troop some days and wrangle others in a single signup
- **Wrangler Signups**: Non-costumed helpers can sign up without being full members
- **Social Events**: A plain signup sheet for events that are not troops - one list of
  attendees, no costumes or contact details asked for, and no troop report
- **Maximums and a Waitlist**: Cap how many troopers and wranglers an event takes; once
  it is full, signups join a waitlist that hands places out in signup order as they free up
- **Prerequisites**: TK ID, WWCC, preferred name, mobile number, and emergency contact validation
- **Costume Selection**: Select from user's profile costumes during signup, or name a
  preapproved costume when the board allows it
- **Region Filtering**: Filter events by region. The region list is the board's own -
  add, rename and delete regions in the Admin CP
- **Archived Events Kept Aside**: The index shows what is coming; events that have been
  closed out are one tick of **Show archived** away rather than gone
- **Calendar & List Views**: View events in calendar or list format, switched with one
  button, and the board opens each member's index in whichever view they last used
- **Attendance Sheets**: Generate print-friendly attendance sheets
- **Troop Reports**: Automated troop report generation and posting
- **Automated Reminders**: PM reminders for incomplete troop reports
- **Troop Attendance**: Every posted troop report records who trooped and who wrangled,
  and in what costume. The Admin CP ranks members, events, regions and costumes from it,
  with charts, and each member sees their own history in the User CP
- **Print Layouts**: Every page prints as a document - no board chrome, a compact masthead,
  and an attendance sheet built for a clipboard
- **iCal Export**: Export events to calendar applications
- **Calendar Subscription**: Each member can make a private link their calendar app
  subscribes to. It carries every event they have signed up for and follows their
  signups: drop a day or withdraw, and it leaves their calendar on the next refresh
- **Forum Announcements**: Every live event gets a generated thread in the forums, in the
  forum configured for its region, rewritten whenever the event changes
- **Events Are Threads**: An announced event is read in its thread - members see the event
  card in place of the first post, with the discussion as ordinary replies beneath it. The
  list, the calendar and `event.php` all lead there; guests and Tapatalk see the generated
  post instead
- **Board Navigation**: Takes over MyBB's Calendar menu item, and only shows the Events
  link to members who can open the events page

## Installation

1. Expand the release zip into your forum's root directory (the one holding `global.php`),
   merging into the existing `inc/`, `jscripts/` and `admin/` folders - or, from a checkout,
   upload the contents of the `plugin/` directory there. Both mirror a forum root, so
   nothing needs moving by hand. If your board's Admin CP directory has been renamed from
   `admin`, put `admin/modules/events/` under that directory instead
2. Go to Admin CP → Plugins
3. Find "Event Management" and click "Activate"
4. Go to Admin CP → Event Management → Settings
5. Configure the plugin settings:
   - Set the event timezone (see _Event Timezone_ below)
   - Map custom profile fields (costume, TK ID, WWCC, preferred name, mobile, emergency contact)
   - Turn working with children checks off if the garrison does not use them, or name the
     check the way your state does (e.g. "Blue Card" in Queensland; the default is "WWCC").
     Turned off, events no longer offer the requirement and nobody is asked for a number;
     an event saved requiring one keeps that, and requires it again if the check is
     turned back on
   - Turn **Preapproved Costumes** on to let troopers name a costume they are preapproved
     for (see _Preapproved costumes_ below). It starts off. With it on, **Preapproval
     Requirements** takes a link to the post setting out how a member gets preapproved
   - Set GEC user groups
   - Set Garrison Members and 501st Members group IDs
   - Set troop report forum ID
   - Edit the regions, and set the forum each one's events are announced in. A default
     forum covers the regions that have none of their own
   - Set the print logo (optional - defaults to the theme's own logo)

## Requirements

- MyBB 1.8.x
- PHP 7.4+ (tested on 7.4 and 8.5)
- MySQL/MariaDB
- Custom profile fields must be created in MyBB Admin CP before mapping them

## Custom Profile Fields

Before using the plugin, create the following custom profile fields in MyBB:

1. **Costume Field** (multi-select, or a comma separated text field): User's available costumes
2. **Legion ID Field** (text): User's 501st Legion ID, e.g. TK-12345
3. **WWCC Field** (text): Working With Children Check number. Not needed if the check is
   turned off
4. **Mobile Number Field** (text, hidden): Mobile phone number
5. **Emergency Contact Field** (text, hidden): Emergency contact information
6. **Preferred Name Field** (text): The name a member goes by on the day, which is what the
   attendance sheet greets them by - the username beside it is a forum handle

The mobile and emergency contact fields should be configured as hidden fields (visible only to admins/GECs).

## Upgrading

Upload the new `plugin/` over the old one, then deactivate and re-activate the plugin in
Admin CP → Plugins. MyBB has no upgrade step for plugins, so activation is where the plugin
brings an existing board up to date: it runs any schema upgrades the board has not had yet,
adds new settings (leaving existing ones as they are) and re-syncs its templates and
stylesheet.

## Event Timezone

Every date the plugin holds - an event's start and end, the hours of each day, the signup
cutoff, when a signup was made, when a troop report was posted - is a plain wall clock. It
carries no offset, so **Event Timezone** (Admin CP → Event Management → Settings) is what
gives those clocks their meaning, and the plugin uses it everywhere: entering a date,
storing it, showing it back, deciding that a cutoff has passed, deciding that an event has
finished and a troop report is due, and chasing that report with the weekly reminder PM.

The server's own timezone is deliberately not used. A garrison's events happen where the
garrison is, whatever timezone the forum happens to be hosted in, and a move between hosts
must not walk every cutoff on the board an hour sideways. Set this to the zone the garrison
runs in and it no longer matters what the host is set to.

Daylight saving is handled by the zone rather than by an offset: pick `Australia/Sydney`,
not "UTC+10". The offsets shown beside each zone in the dropdown are the ones in force
right now, and a zone that observes daylight saving will read an hour out for half the
year - the plugin follows the zone, not the label.

A board starts on UTC and names its own zone here. A setting naming a zone this PHP build
has never heard of falls back to UTC too, which is the one zone every build can resolve.

The one place an absolute instant is written rather than a wall clock is the iCal feed
(`ical.php` and `ical_feed.php`), which converts out of the event timezone into UTC so a member's calendar app
shows the event at the right local time wherever they are.

Changing the setting reinterprets the dates already stored rather than converting them: an
event entered as 18:00 stays 18:00, now meaning 18:00 in the new zone. On a board that has
been running in the wrong zone that is usually what is wanted, but a board whose events
genuinely happened in the old one should expect the change to move them.

## Usage

### The Events Index

`events.php` is the way in, and it has two views of the same schedule: a **list** and a
**calendar**. The control that swaps between them names the view it goes to rather than
marking the one you are already looking at, and sits at the far right of the toolbar,
away from the filters - which view you are in is a property of the page, not a filter on
it. Which one you chose is remembered per account, so the navigation link and a bookmark
both open where you left off.

The board draws the page's own heading from the breadcrumb, so the plugin does not add a
second one. On the calendar the month is the label on the stepper that changes it -
`« October 2026 »` - rather than a heading bar repeating what the page already says.

**Filters apply as they are changed.** Picking a region or ticking Show archived reloads
the listing there and then; there is no Filter button to press. The button still exists
in the markup inside a `<noscript>`, so the page works with JavaScript turned off, and
the server validates what arrives either way. Both filters travel across the view toggle
and the calendar's month paging.

### Creating Events

Coordinators run events but are not board administrators, so an event can be built from
either end. Both forms ask the same questions, validate the same way and write the same
rows - `events_form.php` holds the reading, validating and saving, and the two pages only
render it.

**From the front end** (GECs and admins):

1. Go to Events and click "Create Event"
2. Fill in the event details (below)
3. Click "Create Event" - it lands on the new event's page

**From the Admin CP** (admins):

1. Go to Admin CP → Event Management → Events
2. Click "Add New Event"
3. Fill in the event details (below)
4. Save event

Either way the details are:

- Title, description, region. The title is 64 characters at most: it becomes the subject
  of the announcement thread, the troop report and the reminder PMs, behind prefixes as
  long as "Troop Report Needed: ", and MyBB refuses a subject over 85
- The description is written in the board's own BBCode editor, on both forms, and rendered
  the way a post is - on the event page and in the announcement thread alike. **Preview**
  beside the save button shows what it will look like without saving anything. HTML is not
  allowed; the board's own MyCode settings decide which tags are. A member who has turned
  the BBCode editor off in their own options gets a plain box, and BBCode typed into it is
  parsed the same way
- Address (optional) - where the event happens. Wherever it is shown - the event page, the
  events listing, the calendar and the announcement thread - it is a link to a Google Maps
  search for it, opened in a new tab, and it is the `LOCATION` an attendee's downloaded
  calendar entry carries. An event with no address simply shows none, and its calendar
  entry falls back to naming the region
- Start and end dates. Both need a time as well as a date - there is no default, since
  midnight would put the end at the *start* of the last day - and the end has to be later
  than the start
- Type - a troop (the default) or a social event. See [Social Events](#social-events)
- Signup cutoff (optional - with none, signups stay open until the event ends)
- Maximum troopers and maximum wranglers, or for a social event maximum attendees
  (optional - empty is no limit). On an event of several days each is a limit per day.
  The form shows only the chosen type's. See [Maximums and the Waitlist](#maximums-and-the-waitlist)
- WWCC requirement
- GEC assignment - see below
- Event days - the hours the event runs on each of its days. The rows follow the start
  and end dates rather than being typed, and a single-day event has none at all. A night
  that runs past midnight is not a second day: an event shorter than a day is on the
  date it starts, and one that ends before 06:00 finished the night before, so a
  22:00 to 01:00 troop is one night and two such nights are two rows. A day whose end
  time is earlier than its start runs overnight, and has to be over before the next
  day's start time
- Excluded users (optional) - a tag field: type part of a username, pick the member from
  the list it filters down, and they appear as a lozenge with an X to take them off again.
  Only a member who exists can be added, and an excluded member is not shown the event at
  all - see below

A new event starts as **Pending**, which is visible to coordinators only. Set it to Live
when it is ready to take signups.

### Event Statuses

An event is **Pending**, **Live** or **Archived**, and the status decides who sees it on
the events index and whether it takes signups.

| Status   | On the events index                   | Signups                                         |
| -------- | ------------------------------------- | ----------------------------------------------- |
| Pending  | Coordinators and admins only          | Closed                                          |
| Live     | Everybody, by default                 | Open, subject to the cutoff and the event's end |
| Archived | Only when **Show archived** is ticked | Closed                                          |

Archiving is how an event is closed out, not how it is deleted. Posting its troop report
archives it automatically, and a coordinator can set the status by hand from either form.
An archived event keeps everything it had - its page, its announcement thread, its signup
list and its troop report - and every link to it still works. It just stops crowding the
index, which is a schedule of what is coming rather than a record of what has been.

**Show archived** sits next to the region filter on both the list and the calendar, and
it works alongside the region filter rather than replacing it. Ticking it applies
immediately, like every other filter on the bar. It is per-visit:
it travels across the view toggle and the calendar's month paging, so paging back through
last year keeps showing them, but a fresh visit to Events opens on the upcoming schedule
again. Unlike the list/calendar choice, it is not remembered between visits.

### Regions

A region is the label an event is filed under: the events listing filters by it, and an
event's announcement thread goes to that region's forum. The list lives in Admin CP →
Event Management → Settings, one row per region, and ships as Sydney, Hunter, Canberra
and Other for a board that does not change it.

- **Renaming** one is a matter of editing its box and saving the page. Every event filed
  under it comes with it, and so does its announcement forum.
- **Adding** one is the Add Region button. It can be used on an event the moment it
  exists; its announcement forum is set on its row afterwards.
- **Deleting** one is the × at the end of its row. If any events are filed under it, the
  confirmation asks which region they should move to and moves them - the plugin will not
  leave an event filed under a region that no longer exists, because such an event is
  invisible to the region filter and cannot be saved from the event form. The board
  always keeps at least one region.

A region name cannot contain a comma or an equals sign, and is at most 64 characters.

### Who Can Be Assigned as Coordinator

The Coordinator dropdown is not the whole membership. It is drawn from the groups named in
**Event Coordinator User Groups** (Admin CP → Event Management → Settings), matching either
a member's primary group or any of their additional ones, and listed alphabetically. The
same setting is what grants the right to coordinate in the first place, so the list and the
permission cannot drift apart.

Two people are always on the list whether or not they are in those groups: whoever is
filling the form in, who can take the event on themselves, and the event's existing
coordinator - editing an event is not the place to be told its coordinator is no longer
valid. Neither shortcut widens the list for anybody else, and an event handed to somebody
outside the groups is rejected as a forged post rather than saved.

With no groups configured, the only choice offered is the person creating the event.

The list opens with a blank **Choose a coordinator**. An event whose coordinator has since
been deleted shows that instead of a name, and cannot be saved until somebody is picked -
otherwise the box would fall back to whoever sorts first, and saving the event for any
other reason would quietly hand it to them.

### Announcement Threads

Going live posts the event to the forums. The thread is generated from the event - dates,
region, address, coordinator, signup cutoff, WWCC requirement, the day-by-day schedule,
the description and a link back to the event page - so there is nothing to write and
nothing to keep in step by hand. Members discuss the event in the replies.

The description is carried into the post as written, BBCode and all: it is the one field
a coordinator writes markup in on purpose, and it renders the same way on the event page.
Everything else the post is built from is data rather than markup, and is neutralised on
the way in - a venue or a username containing `[url=...]` would otherwise rewrite the line
it sits on.

Which forum it lands in follows the event's region: Admin CP → Event Management → Settings
holds one forum per region plus a **Default Event Forum** for the regions that have none
of their own. A region with neither is not announced, and the coordinator is told so when
they save.

Editing an event rewrites the opening post rather than posting a second thread, and
correcting a region moves the thread to that region's forum - unless a moderator has
already filed it somewhere else, in which case it is left where they put it. Deleting the
thread makes the next save write a fresh one. Pending events are not announced, and an
archived event keeps its thread.

### Editing an Event

The same form edits. From the front end it is "Edit Event" on the action bar at the
foot of the event (`manage_event.php?id=N`); from the Admin CP it is the Edit action on the
event list. A coordinator can change anything about an event including its status, so
taking an event live, correcting a date or adding a day never needs Admin CP access.

Deleting an event stays in the Admin CP.

### Excluded Members

Excluding somebody hides the event from them rather than locking the signup button. The
event leaves their events listing and their calendar, its page, its calendar feed and its
troop report form all answer the way any page that is not theirs does, and its
announcement thread cannot be opened, printed, replied to, searched for, found in the
forum it was posted into, or named as that forum's latest post on the board index. The
alternative - the event in full view with "you have been excluded from signing up" beside
the list of everybody who is going - is a worse way to be told than not being told.

Excluding somebody who has already signed up withdraws their signup, exactly as if they
had withdrawn it themselves first: they come off the attendance sheet and out of the
counts, and they are not sent a PM about it. They could not withdraw it any other way,
since the event is hidden from them. The save's confirmation message says how many
signups went. Activating the plugin withdraws any such signup left over from before this
was the case.

Two things are deliberately still visible:

- **The troop report.** It is posted to the troop report forum as its own thread and is
  left alone, so an excluded member can read the garrison's record of what happened. Its
  subject names the event, which is how they find out the event took place - after it is
  over, which is the point of a report.
- **The event, to whoever runs it.** A coordinator is never hidden from their own event,
  and neither are general coordinators or administrators: an event nobody can open is an
  event nobody can put right. They still cannot sign up to it.

MyBB has no per-thread permission, so hiding the announcement means telling each place
that could name a thread separately. Two counters are left over, and both are numbers
rather than subjects: the thread and post totals on the board index are cached columns on
the forum, and the count behind a forum's page links is taken further up the page than any
hook MyBB offers. A board running MyBB's portal should also know that its "latest
discussions" list offers no hook at all, so an announcement can appear there.

### Signup Process

There is one way in. Members sign up to _attend_, and choose how they are attending as part
of the same flow.

1. Users browse events on the Events page
2. Click on an event to view details
3. Click "Sign Up to Attend"
4. **Attendance**: choose how each day is being attended - trooping, wrangling, or not at
   all. Every day starts on trooping, so the common case is one click past this step. A
   single-day event (one with no configured days) asks for one answer instead of one per
   day, and names when it is - "You are signing up to Hunter Valley Toy Run - Oct 20 at 9am" -
   because a member arriving from a reminder or a link is usually answering "can I make
   that?". The step does not explain what a trooper or a wrangler is; members know.
5. Complete any missing prerequisites (saved back to the user's profile)
6. Select costumes
7. Confirm

Steps 5 and 6 only appear when they apply: the TK ID is only asked for once a day is being
trooped, and the costumes step does not exist for a signup that is wrangling throughout. A
wrangler with a complete profile therefore answers one question and confirms.

### Preapproved costumes

With **Preapproved Costumes** turned on in Admin CP → Event Management → Settings, step 6
also offers "Preapproval:" with a text box, for a costume a member has been cleared to troop
in that is not on their Legion record yet. It can be picked on its own or alongside costumes
from their profile, and is saved as a costume named `Preapproval: <what they typed>`, so the
attendance list, troop report and costume filter show it as it is. Step 6 is then shown to
every trooper, including one with a single costume on file (it comes ticked). With the
setting off, a member with one costume skips step 6 and troops in that costume.

When **Preapproval Requirements** names a post, a member who fills in a preapproval is shown
that post on step 6, rendered as it reads in its thread, and must tick "I have followed
these steps and have received confirmation of preapproval for this costume for this event"
before they can go on. The tick is not stored, so it is asked for every time they sign up
or edit a signup that uses a preapproval. The setting accepts a link to the post (or to
its thread, meaning the first post) or a post ID, and is stored as the post ID. A post
that has since been deleted or unapproved counts as none, and nothing is asked.

### Costumes from the 501st Legion API

Every time a member answers step 4 with any day trooped, their approved costumes are
fetched from the 501st Legion's public API by the Legion ID on their profile, and written
over their costume field one per line as `<designation> - <costume>`, e.g.
`TK - Stormtrooper: ANH Stunt`. Steps 5 and 6 then work from that list. A comma in a
costume's name is dropped, since the field is also read as a comma separated list.

When the API is down, slow (over 5 seconds), answers with an error, lists no costumes, or
returns a "Classified Record", the field is left as it is and the signup uses the costumes
on file. A classified record is a member who has made their details private on 501st.com;
the API answers the same way for an ID nobody holds, so the two cannot be told apart.
Nothing is fetched for a member with no Legion ID on file, or for a signup that is
wrangling throughout.

Step 5 asks for costumes last. A member missing their Legion ID is asked for it with the
other details, it is looked up when they save, and only if that turns up no costumes is
the step shown again with the costume field on its own. While they type the Legion ID, the
step shows who it belongs to - name, garrison and approved costumes - looked up through
`xmlhttp.php?action=events_legion_lookup`, so they can see what they are linking before they
save it. That lookup needs JavaScript; without it the step works the same, just without the
preview.

The API's address is **501st Legion API** in Admin CP → Event Management → Settings, and
starts as `https://api.501st.com`. Leave it blank to use only the costumes on members'
profiles. The fetch needs PHP's curl extension; without it the board behaves as if the API
were down.

Signups close at the event's signup cutoff. Events with no cutoff stay open until the event
ends, so a late signup can still be recorded.

### The Days Column

A multi-day event's attendance sheet carries a **Days** column saying when each person
intends to turn up. It reads the way a coordinator would say it out loud:

| Signup                              | Days column                             |
| ----------------------------------- | --------------------------------------- |
| One day of three                    | Saturday                                |
| Two days of three                   | Saturday, Sunday (as bullets)           |
| Every day, one role                 | All Days                                |
| Trooping Saturday, wrangling Sunday | Saturday (Trooping), Sunday (Wrangling) |

Filtering the sheet to one day answers with that day rather than reciting the rest of the
signup around it. An event with no configured days has no Days column at all rather than an
empty one.

### Changing a Signup

The signup wizard doubles as the edit form. While signups are open the event page offers
"Update Your Signup", which re-opens the wizard with the current selections pre-filled;
confirming rewrites the signup. That is how somebody adds wrangling to a signup they made
as a trooper, drops a day they can no longer make, or swaps a costume.

Rewriting keeps the existing row for any role that is still held, so its original signup
date - which is what a coordinator sorts on - survives the edit. A role that is dropped
entirely has its row, days and costumes deleted.

A member who has to pull out does it from the same form. The edit form's "How are you
attending?" question has a third answer, **Not attending**, and picking it (or marking every
day as not attending in the per-day grid) goes straight to a confirm step. Confirming
deletes the signup, including its days and costumes. The first signup form doesn't offer
this, and still requires at least one day, since there is nothing to withdraw yet. Like any
other change to a signup, withdrawing is only possible while signups are open. After the
cutoff, a member who can't make it still has to ask the coordinator.

### Roles

A wrangler is a non-costumed helper - a partner, friend or handler who assists on the day.
Wranglers are not required to be full members, so they are never asked for a TK ID and never
pick a costume.

Roles are recorded per day, so a weekend event can be trooped on the Saturday and wrangled
on the Sunday. That is stored as two rows in the signup table - one per role, each with its
own days - which is why the table is keyed on `(event_id, user_id, role)`. A member holding
both roles counts once in each of the trooper and wrangler totals.

The days are a calendar of the event: one per date between its start and end. The event
form derives them rather than asking for them, so a day cannot name a date the event does
not cover, and an event inside a single date has no days at all - which is what the signup
wizard reads as a one-day event and asks one question about instead of one per day.

That does mean two sessions on the same date - a morning and an afternoon - are one event
day rather than two, and a member who can only make the morning signs up for the day.

Wranglers appear in their own section of the troop report, in the coordinator RSVP list and
on the attendance sheet, and are counted separately from troopers everywhere a signup count
is shown. The events listing and the Admin CP event list break the figure down into
troopers and wranglers, so an event with helpers but no costumed attendance reads as
"0 troopers, 1 wrangler" rather than an unexplained zero. They
are not sent troop report reminders, and cannot author a troop report - that is troopers
only, since the report records costumed attendance.

### Social Events

An event's type is a troop unless the form says otherwise. A social event - a dinner, a
barbecue, a movie night - is a plain signup sheet:

- **One role.** Members sign up as attendees. There is no trooping or wrangling to choose
  between and no costume step, so a first signup to a one-day social event skips the
  "are you attending?" question and opens on the confirmation (after asking for anything
  missing), which says when and where. The question comes back when editing, where "Not
  attending" is the other answer, and a multi-day social event still asks it, to let a
  member pick the days they are coming.
- **Nothing asked for but a name.** The signup asks for a preferred name (and the WWCC,
  if the event requires one). It does not ask for a mobile number, an emergency contact, a
  Legion ID or a costume.
- **A cap and a waitlist if you want one.** Maximum attendees works exactly as the troop
  maximums do - see below.
- **No troop report.** A finished social event reads as Complete rather than Needs Troop
  Report, offers no report to write, sends no reminders, and `troop_report.php` refuses it.
  Nobody is credited with trooping it, so it appears nowhere in Troop Attendance, Reports
  or My Troops, and the Reports tab's Nudge never suggests one.
- **The attendance sheet stays.** The point of contact, the coordinator and admins still
  get the sheet and the Admin CP signup list. It leaves out the Legion ID and costume
  columns, and still shows any mobile number or emergency contact a member has on file.

The listing marks a social event with a **Social** pill and counts its attendees as "A";
the event page and the announcement thread both name the type.

An event's type cannot be changed once anybody has signed up to it: a troop's signups are
troopers and wranglers and a social event's are attendees, so the change would leave every
signup in a role the event no longer takes. Withdraw the signups first, or create a new
event.

### Maximums and the Waitlist

An event can be given a maximum number of troopers and of wranglers - or, for a social
event, of attendees. Once one is reached,
the event is still open to sign up to, but anybody who signs up for that role joins a
waitlist instead of getting a place. Every step says so: the event page's button reads
**Join Waitlist** once either role is full,
the wizard labels a full role "full - join the waitlist", and the confirm button reads
**Join the Waitlist** rather than Confirm Signup. Joining the waitlist asks for exactly the
same prerequisites as signing up does, so a member who gets a place is already able to take it.

On an event of several days, each day has its own places and its own waitlist, so a member
can have a place on the Sunday and be waiting for the Saturday. The maximum is the same
number for every day.

The rule behind every change is one sentence: in each role's queue for each day, ordered by
when each person signed up for it, the first *maximum* people have a place and the rest are
waiting. So:

- **Somebody drops out** - withdraws, drops a day, is excluded or is deleted - and the first
  person waiting for that role on that day gets the place.
- **The maximum is raised**, and that many more people get places, in signup order.
- **The maximum is lowered**, and the most recent signups go back onto the waitlist. They
  signed up before anybody already waiting, so they wait at the front of it. Both event
  forms stop and list who would move before saving, the same way removing a day does.

Everybody the waitlist moves is sent a PM, whichever way they moved. The PM comes from whoever
edited the event, or from the event's coordinator when a member's own dropout freed the place.
An event that has finished is never reshuffled, so tidying its maximum afterwards changes
nobody's record and PMs nobody.

The waitlist is shown under "Who is Attending" on the event, in signup order rather than by
name. On the attendance sheet it gets a table of its own under the attendees, one per day on an
event of several days, marked **Waitlist** and numbered W1, W2 and so on. It carries the same
contact details, so a point of contact whose trooper doesn't show can ring down it in order.
Waitlisted members are never on the troop report, can't write one, aren't sent its reminders,
and don't get calendar entries for the days they are waiting for.

### Printing

Every page the plugin renders is built to come off a printer as a document rather than as a
screenshot of a forum. Printing one drops the board's masthead, navigation, welcome bar,
breadcrumb and footer, along with the filters and buttons that only do something in a
browser, and replaces the lot with a slim branded ribbon - logo, board name and what the
sheet is - over the title and its facts.

The ribbon is filled with `--events-accent`, the same custom property that tints the
plugin's buttons and pills, so a theme brands the printout by declaring it once. It sets
`print-color-adjust: exact`, which is what makes a browser print the fill and the white
text on it at all: backgrounds are dropped from a print unless the reader turns background
graphics on, and a ribbon that silently printed white-on-white would be worse than none.

The attendance sheet is the one built for paper first:

- one row per person, not per role: somebody trooping the Saturday and wrangling the Sunday
  is one human to tick off, and their **Days** column says which way round
- the column header row repeats at the top of every sheet
- a person is never split across two sheets
- the last column is an **Attended** tick box rather than a signature line. It is a real
  checkbox, so a coordinator can tick people off on screen and print the sheet with those
  ticks already on it - the print is taken from the live page - or print it empty and tick
  it with a pen on the day
- the table is drawn in rules rather than fills, so it reads the same whether or not the
  reader has background graphics turned on
- the masthead carries the event, its region, when it starts and how many people are on the
  sheet, so a printed copy is self-describing once it leaves the screen

None of this is print-only markup bolted onto the templates. The rule is a single one, in
`events.css`: keep `.events_page_wrap` and the ancestors holding it in the document, hide
everything else. Naming a theme's own header and footer would not survive the next theme,
and the stylesheet is attached to the plugin's pages only, so "everything except our page"
is both exact and safe to say. It leans on CSS `:has()` for the ancestor half; a browser
without it throws the rule out and prints what it always printed.

The masthead itself is markup - `{$events_print_header}`, built by `events_print_header()`
and hidden on screen - because it has to live _inside_ that wrapper to survive.

The logo comes from the **Print Logo** setting, which takes a URL or a path relative to the
board root. It falls back to `$theme['logo']`, MyBB's own place for a theme's logo, so a
theme that fills that in needs no configuration; a theme that hardcodes its logo into the
header template (as the garrison's does) leaves it empty, which is what the setting is for.
With neither, the ribbon prints without a logo.

It is painted as a background image declared inside `@media print`, with the page handing
the URL over in a `--events-print-logo` custom property, rather than as an `<img>`. A
browser fetches an `<img>` even inside a `display: none` element - `loading="lazy"`
included - so an `<img>` would make every visit to every page of the plugin pay for a file
only a printout ever shows.

### GEC Event Management

GECs can manage events and RSVPs directly from the event page (no Admin CP access required):

1. **Viewing RSVPs**:
   - Navigate to an event - the signup list sits on the event page itself, under the
     description, and is visible to everybody who can see the event
   - Filter by costume or day as needed

2. **Attendance Sheets**:
   - Click "View Attendance Sheet" on the action bar at the foot of the event
   - A print-friendly page will display with all attendee information
   - Use browser print function (Ctrl+P / Cmd+P) to print or save as PDF

3. **Event Management**:
   - Create an event from the "Create Event" button on the events listing
   - Edit one, including its status, from "Edit Event" on the same bar
   - Admins can do the same in Admin CP → Event Management → Events, which additionally
     deletes events

### Troop Reports

1. After an event ends, any attendee can create a troop report
2. Go to the event page and click "Create Troop Report"
3. Edit the draft report
4. Post to the designated forum
5. The plugin automatically comments on the event's announcement thread and archives the event

### Troop Attendance

Posting a troop report records who was there: every member signed up to the event
(attending or waitlisted) whom the report names is counted once for that event, in the
role they signed up for, with the costumes their signup listed. The report is the record.
Take somebody who didn't come out of the draft, or add somebody who came off the waitlist
on the day, and the count follows it.

A member is named when the report has:

- **their username**, as a word of its own and in its own case. The draft writes usernames
  exactly as they are stored, and a username that is an ordinary word ("Rex") would
  otherwise be found in the write-up.
- **and, for a trooper with a Legion ID on file, its number**, with or without the prefix -
  `TK-12345`, `TK12345` and `12345` all count. A number on its own could be a postcode or a
  head count, and a name on its own could be a mention of somebody who stayed home.

Wranglers hold no Legion ID, so for them the username is enough, and so it is for a trooper
with no ID recorded. The generated draft's roll call (`Ash - trooper1 - TK-20001`) meets
the rule, so a report posted as drafted counts everyone it lists.

Editing the report's first post - from the edit page or with quick edit - counts it again
from scratch. Editing a reply in the report's thread does not. Only reports posted since
this shipped are counted; older ones are left as they were.

A deleted member's troops stay. They still count towards their events, regions and
costumes, the reports list them as **[deleted user]**, and recounting a report keeps them.
There is nothing left to recount them from, since their signup went with them. Deleting an
event takes its attendance with it.

### Reports

Admin CP -> Event Management -> **Reports** is open to coordinators and administrators and
has four views, each sortable most-first or least-first and filtered by date range, region
and role. The filters are folded under a bar that says what they are set to ("Events, least
first · From 2026-01-01 · Hunter · Any role"), and open when the bar is clicked:

- **People** - troops per member, split trooper/wrangler, their most worn costume and their
  last troop
- **Events** - how many each event counted, against how many signed up
- **Regions** - troops, events, the average per event and how many members
- **Costumes** - how often each was worn, by how many members, and when it was last out

Above each view are headline cards, a month-by-month chart and the top ten of the view as
bars, all for the current selection and all about what that view counts:

| View | Cards | Month chart |
|---|---|---|
| People | members trooping, troops, average per member, most active | members trooping |
| Events | events reported, troops, average turnout, best attended | troops, troopers and wranglers stacked |
| Regions | regions, events, troops, busiest region | troops, stacked by region |
| Costumes | costumes worn, times worn, members in costume, most worn | costumes worn, stacked by costume |

The region and costume charts name the first five - regions in the order the region list
has them, costumes by how often each has been worn overall - and fold the rest into
"Other regions" or "Other costumes". A region or costume keeps its colour whatever the
filter, and is the same colour in the month chart and in the bars beneath it.

Only what has been counted is ranked, so "least first" starts with members who have
trooped once, not with members who never have.

### My Troops

Each member's own figures are in the User CP under **My Troops**
(`usercp.php?action=events_troops`): how many troops they have done and in which role,
when they last trooped, their most worn costume, a chart of the last twelve months, the
costumes they have worn, and every troop, newest first. It also says how many of the garrison they
out-troop. That is the share of the garrison's members group, plus anyone else with a troop
counted, who have trooped fewer events than they have.

The page only ever shows the member viewing it. It takes no member to show, so there is no
way to ask it for anybody else's.

## Calendar Subscription

`calendar_feed.php` is where a member makes a private link; it is offered after signing
up for an event. The same page is in the User CP, as **Calendar Subscription** under
Miscellaneous (`usercp.php?action=events_calendar`); both manage the one link. Opening it offers the calendar app's subscribe dialog (`webcal://`),
and the same address can be pasted into Google Calendar's *Other calendars -> From URL*.
The app then fetches `ical_feed.php` on its own schedule - Google roughly daily, Apple and
Outlook more often - and keeps its copy in step with it, which is how a day the member
drops, or an event they withdraw from, leaves their calendar. A downloaded `.ics` can only
ever add. The feed covers every event they are signed up for that ended within the past
year or has yet to happen, with the same entries and UIDs the one-event download produces.
Each entry's title leads with the role the member holds that day - "Trooping: Supanova
Sydney", or "Trooping and Wrangling: ..." for a day held in both - so the calendar grid
says what the day is without the entry being opened. A one-event download for an event the
member has not signed up for keeps the bare title.
An event with an address also gets a Google Maps search link in its description, which
every calendar app makes clickable. It does the lookup when opened, so nothing is geocoded
here, and it is how a subscribed entry gets a map in apps that do nothing with a plain
`LOCATION`.

The link carries the member's only credential for the feed, since a calendar server has no
session, so it is handled like a password:

- The token is 64 bytes (512 bits) from the OS's secure random source, 86 characters in
  the URL. Nothing about it can be guessed or narrowed.
- Only its SHA-256 is stored. A backup or leaked copy of the database opens no feed.
- It is shown once, on the page that makes it. The member can make a new one at any time,
  which turns the old one off immediately, or turn the feed off altogether.
- Every fetch is checked afresh as that member: a banned member's feed answers nothing,
  a deleted member's token is removed with them, and an event they are excluded from or
  that goes back to pending drops out.
- Every refusal - malformed, unknown, revoked, banned - gets the same `404 Not found.`,
  so a request cannot tell a token that once worked from one that never did.

The token travels in the query string, as every calendar feed's does, so it appears in the
web server's access log. Anyone with access to those logs can read it; treat them
accordingly.

## File Structure

```
/events.php                       # Events index (list and calendar views)
/event.php                        # Single event with its signup list, attendance sheet
/manage_event.php                 # Event create / edit form for coordinators
/rsvp.php                         # Signup wizard (also the edit form)
/troop_report.php                 # Troop report drafting and posting
/ical.php                         # iCal export of one event
/ical_feed.php                    # A member's calendar subscription feed
/calendar_feed.php                # Where a member makes, resets or turns off that link
                                  # (My Troops is served from usercp.php)

/inc/tasks/
  events_reminders.php            # Scheduled task entry point

/inc/plugins/
  events.php                      # Plugin metadata, install / activate / uninstall
  /events/
    LICENSE                       # Apache License 2.0
    NOTICE                        # Attribution, restated on the Admin CP's Support tab
    /inc/
      events_functions.php        # Core helper functions
      events_form.php             # Reading, validating and saving an event
      events_render.php           # Shared HTML building helpers
      events_ical.php             # iCal rendering shared by the export and the feed
      events_feed.php             # Calendar subscription tokens
      events_thread.php           # Generating and maintaining event announcement threads
      events_troop_report.php     # The troop report draft, and posting a report
      events_attendance.php       # Troop attendance: counting it, and the statistics
      events_charts.php           # The Reports tab's and My Troops' charts
      events_hooks.php            # Hook callbacks and the reminder job
      events_install.php          # Database installation
      events_templates.php        # Template installation
      events_tasks.php            # Scheduled task registration
      events_uninstall.php        # Database cleanup
    /admin/
      events_admin.php            # Admin CP dispatcher
      events_admin_events.php     # Event CRUD
      events_admin_rsvps.php      # RSVP review
      events_admin_reports.php    # Attendance reports
      events_admin_settings.php   # Plugin settings
      events_admin_regions.php    # The region list: renames, additions and deletions
      events_admin_support.php    # The Support tab: credit and licence
    /templates/                   # Synced into MyBB's templates table on activate
      events_list.html
      events_calendar.html
      events_event.html
      events_event_form.html
      events_rsvp_form.html
      events_rsvp_success.html
      events_rsvp_list.html
      events_attendance.html
      events_troop_report.html
      events_usercp_troops.html
    /upgrades/                    # Schema changes, one file each, run on activation

/jscripts/events/                 # Assets the Admin CP and the front end share
  events-datepicker.css
  events-tags.css
  events-admin.css                # The Admin CP's own controls, which load no theme
  events-charts.css               # The attendance charts, in the Admin CP and the User CP
  jquery-ui-datepicker.js

/admin/modules/events/
  module_meta.php                 # Admin CP menu registration
  index.php                       # Admin CP entry point
```

The front-end pages live at the web root because MyBB pages `require ./global.php`. The
repository's `plugin/` directory is laid out exactly like this, so it can be uploaded over a
forum root as-is; `scripts/deploy.sh` does the same thing for the test forum, and the
release zip is its contents.

## Styling and Theming

Front-end styling lives in `events.css`, installed as a real theme stylesheet on the master
theme. Nothing is inlined into a template, so a theme restyles the plugin the same way it
restyles anything else.

The plugin's forms are built from its own classes rather than MyBB's `.form_row`, which
lays a label, its control and its hint out on one line and leaves the control itself
unstyled. Each field is a stack instead - `.events_label`, then `.events_input`, then an
`.events_hint` wired to the control with `aria-describedby` - and tickable lists of
costumes or ways to attend a day are `.events_option` rows whose whole width is the hit
target.

A theme retints all of it by declaring the accent custom properties once:

```css
:root {
  --events-accent: #1090d0;
  --events-accent-border: #1090d0;
  --events-accent-soft: rgba(16, 144, 208, 0.18); /* the focus ring */
}
```

and restyles individual controls with rules written under `.events_page_wrap`:

```css
.events_page_wrap .events_input {
  border-radius: 3px;
  border-color: #ccc;
}
```

The wrapper is needed because this stylesheet is installed last in the display order, so an
equally specific rule in the theme's own sheet would lose the tie and silently do nothing.

## Generated Content

The troop report draft is a BBCode document that the author edits before posting, so the
document stays authorable while the data interpolated into it does not. Usernames, TK IDs,
costumes and the event title all pass through `events_escape_bbcode()`, which rewrites
brackets as `&#91;`/`&#93;` - MyBB's parser preserves numeric character references, so they
render as literal brackets instead of opening a tag.

The draft is then written into the textarea with plain `htmlspecialchars()`, **not** MyBB's
`htmlspecialchars_uni()`. The latter preserves `&#91;`, which the browser would decode back
to `[` as the textarea's value and quietly undo the escaping on submit.

## Database Tables

All tables use the `mybb_event_plugin_` prefix:

- `event_plugin_events` - Main events table
- `event_plugin_event_days` - Multi-day event support
- `event_plugin_event_exclusions` - Users excluded from RSVPing
- `event_plugin_rsvps` - Signup records; `role` is `trooper` or `wrangler` on a troop and
  `attendee` on a social event (the event's `event_type`), unique per
  `(event_id, user_id, role)` so a member can hold both - one signup covering a mix of
  trooping and wrangling days is two rows
- `event_plugin_rsvp_days` - Which days user is attending, one claim per day. Each claim
  carries its own `status` (`attending` or `waitlisted`) and `claimed_at`, the order of that
  day's waitlist. A signup's own `status` is attending if any of its days is; on an event
  with no days, it has no claims and the row's status is the whole answer
- `event_plugin_rsvp_costumes` - Costumes per RSVP
- `event_plugin_troop_reports` - Troop report tracking
- `event_plugin_attendance` - Who a posted troop report counts: one row per event,
  member and role. The event's date and region are read from the event rather than
  copied, so renaming a region carries the reports with it
- `event_plugin_attendance_costumes` - The costumes each counted signup listed when the
  report was counted
- `event_plugin_user_prefs` - Per-member preferences; currently which view the events
  index opens in. A member with no row gets the default, so it only holds people who have
  actually used the toggle

Every table is `utf8mb4`, so a title or description can carry emoji. Boards installed
before that shipped with three-byte `utf8` tables, which reject an emoji under strict mode;
re-activating the plugin converts them in place, data included.

## Permissions

- **GEC (Garrison Event Coordinator)**: Can create and edit events, view and manage RSVPs
  for assigned events from the event page, and generate attendance sheets - all without
  Admin CP access. With Admin CP access, also reads the attendance Reports. Editing covers an event's status, so a coordinator takes their own
  event live
- **Admin**: Full access to all features, including the Admin CP event module, which is
  additionally the only place an event can be deleted
- **Users**: Can view live events, sign up to attend (trooping and/or wrangling), update
  their own signup while signups are open, create troop reports, and see their own troop
  history (and only their own) in the User CP
- **Wranglers**: No membership or TK ID required; may sign up to any event they can see, but
  may not author troop reports
- **Point of Contact**: Whoever an event names as its point of contact can open that event's
  attendance sheet, from "View Attendance Sheet" on the event, whether or not they are a
  coordinator. They cannot edit the event or manage its signups

## Development

See the [repository README](README.md) for the Docker development environment and the
end-to-end test suite.

## Support

Created by Kevin Brown (TK-33151) of the [Southern Cross Garrison](https://www.501scg.org/).
Report issues and ask questions on the
[GitHub repository](https://github.com/southern-cross-garrison/mybb-plugin-events). The
Admin CP's Event Management -> Support tab shows the same credit and licence.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE) for
attribution; both files ship with the plugin in `inc/plugins/events/`, and a redistributed
copy has to keep the NOTICE with it.
