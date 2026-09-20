# MyBB Event Management Plugin

A comprehensive event management plugin for MyBB 1.8 that replaces thread-based event signups with a structured system featuring signup tracking, prerequisite validation, multi-day event support, attendance sheets, and automated troop report generation.

## Features

- **Event Management**: Create, edit, and manage events with status (pending/live/archived)
- **Multi-day Events**: Support for events spanning multiple days
- **Signup System**: One "Sign Up to Attend" flow with prerequisite validation
- **Per-day Roles**: Troop some days and wrangle others in a single signup
- **Wrangler Signups**: Non-costumed helpers can sign up without being full members
- **Prerequisites**: TK ID, WWCC, mobile number, and emergency contact validation
- **Costume Selection**: Select from user's profile costumes during signup
- **Region Filtering**: Filter events by region (Sydney, Hunter, Canberra, Other)
- **Calendar & List Views**: View events in calendar or list format
- **Attendance Sheets**: Generate print-friendly attendance sheets
- **Troop Reports**: Automated troop report generation and posting
- **Automated Reminders**: PM reminders for incomplete troop reports
- **Print Layouts**: Every page prints as a document - no board chrome, a compact masthead,
  and an attendance sheet built for a clipboard
- **iCal Export**: Export events to calendar applications
- **Thread Integration**: Link events to forum threads
- **Board Navigation**: Takes over MyBB's Calendar menu item, and only shows the Events
  link to members who can open the events page

## Installation

1. Upload all files to your MyBB installation maintaining the directory structure shown
   under *File Structure* below (the front-end pages go at the web root)
2. Go to Admin CP → Plugins
3. Find "Event Management" and click "Activate"
4. Go to Admin CP → Event Management → Settings
5. Configure the plugin settings:
   - Map custom profile fields (costume, TK ID, WWCC, mobile, emergency contact)
   - Set GEC user groups
   - Set SCG Members and 501st Members group IDs
   - Set troop report forum ID
   - Set the print logo (optional - defaults to the theme's own logo)

## Requirements

- MyBB 1.8.x
- PHP 7.0+
- MySQL/MariaDB
- Custom profile fields must be created in MyBB Admin CP before mapping them

## Custom Profile Fields

Before using the plugin, create the following custom profile fields in MyBB:

1. **Costume Field** (multi-select, or a comma separated text field): User's available costumes
2. **Legion ID Field** (text): User's 501st Legion ID, e.g. TK-12345
3. **WWCC Field** (text): Working With Children Check number
4. **Mobile Number Field** (text, hidden): Mobile phone number
5. **Emergency Contact Field** (text, hidden): Emergency contact information

The mobile and emergency contact fields should be configured as hidden fields (visible only to admins/GECs).

## Usage

### Creating Events

1. Go to Admin CP → Event Management → Events
2. Click "Add New Event"
3. Fill in event details:
   - Title, description, region
   - Start and end dates
   - Signup cutoff (optional)
   - WWCC requirement
   - GEC assignment
   - Event days (for multi-day events)
   - Excluded users (optional)
4. Save event

### Signup Process

There is one way in. Members sign up to *attend*, and choose how they are attending as part
of the same flow.

1. Users browse events on the Events page
2. Click on an event to view details
3. Click "Sign Up to Attend"
4. **Attendance**: choose how each day is being attended - trooping, wrangling, or not at
   all. Every day starts on trooping, so the common case is one click past this step. A
   single-day event (one with no configured days) asks for one answer instead of one per
   day.
5. Complete any missing prerequisites (saved back to the user's profile)
6. Select costumes
7. Confirm

Steps 5 and 6 only appear when they apply: the TK ID is only asked for once a day is being
trooped, and the costumes step does not exist for a signup that is wrangling throughout. A
wrangler with a complete profile therefore answers one question and confirms.

Signups close at the event's signup cutoff. Events with no cutoff stay open until the event
ends, so a late signup can still be recorded.

### The Days Column

A multi-day event's attendance sheet carries a **Days** column saying when each person
intends to turn up. It reads the way a coordinator would say it out loud:

| Signup | Days column |
|---|---|
| One day of three | Saturday |
| Two days of three | Saturday, Sunday (as bullets) |
| Every day, one role | All Days |
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

There is no way to withdraw from an event through the form: at least one day must be
attended, so a member who has to pull out asks the coordinator.

### Roles

A wrangler is a non-costumed helper - a partner, friend or handler who assists on the day.
Wranglers are not required to be full members, so they are never asked for a TK ID and never
pick a costume.

Roles are recorded per day, so a weekend event can be trooped on the Saturday and wrangled
on the Sunday. That is stored as two rows in the signup table - one per role, each with its
own days - which is why the table is keyed on `(event_id, user_id, role)`. A member holding
both roles counts once in each of the trooper and wrangler totals.

Two sessions on the same date (a morning and an afternoon) are two event days, so a member
who can only make the morning drops the afternoon the same way they would drop a whole day.

Wranglers appear in their own section of the troop report, in the coordinator RSVP list and
on the attendance sheet, and are counted separately from troopers everywhere a signup count
is shown. The events listing and the Admin CP event list break the figure down into
troopers and wranglers, so an event with helpers but no costumed attendance reads as
"0 troopers, 1 wrangler" rather than an unexplained zero. They
are not sent troop report reminders, and cannot author a troop report - that is troopers
only, since the report records costumed attendance.

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
and hidden on screen - because it has to live *inside* that wrapper to survive.

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
   - Navigate to an event you're managing
   - Click "View RSVPs" in the Coordinator Controls section
   - Filter by costume or day as needed

2. **Attendance Sheets**:
   - Click "View Attendance Sheet" in the Coordinator Controls section
   - A print-friendly page will display with all attendee information
   - Use browser print function (Ctrl+P / Cmd+P) to print or save as PDF

3. **Event Management**:
   - Admins can create/edit events in Admin CP → Event Management → Events
   - GECs assigned to events can view and manage RSVPs from the event page

### Troop Reports

1. After an event ends, any attendee can create a troop report
2. Go to the event page and click "Create Troop Report"
3. Edit the draft report
4. Post to the designated forum
5. The plugin automatically comments on the event thread and archives the event

## File Structure

```
/events.php                       # Events index (list and calendar views)
/event.php                        # Single event, coordinator RSVP list, attendance sheet
/rsvp.php                         # Signup wizard (also the edit form)
/troop_report.php                 # Troop report drafting and posting
/ical.php                         # iCal export

/inc/tasks/
  events_reminders.php            # Scheduled task entry point

/inc/plugins/
  events.php                      # Plugin metadata, install / activate / uninstall
  /events/
    /inc/
      events_functions.php        # Core helper functions
      events_render.php           # Shared HTML building helpers
      events_hooks.php            # Hook callbacks and the reminder job
      events_install.php          # Database installation
      events_templates.php        # Template installation
      events_tasks.php            # Scheduled task registration
      events_uninstall.php        # Database cleanup
    /admin/
      events_admin.php            # Admin CP dispatcher
      events_admin_events.php     # Event CRUD
      events_admin_rsvps.php      # RSVP review
      events_admin_settings.php   # Plugin settings
    /templates/                   # Synced into MyBB's templates table on activate
      events_list.html
      events_calendar.html
      events_event.html
      events_rsvp_form.html
      events_rsvp_success.html
      events_rsvp_list.html
      events_attendance.html
      events_troop_report.html

/admin/modules/events/
  module_meta.php                 # Admin CP menu registration
  index.php                       # Admin CP entry point
```

The front-end pages live at the web root because MyBB pages `require ./global.php`. In this
repository they are kept under `plugin/root/` and copied into place by `scripts/deploy.sh`.

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
    --events-accent-soft: rgba(16, 144, 208, 0.18);  /* the focus ring */
}
```

and restyles individual controls with rules written under `.events_page_wrap`:

```css
.events_page_wrap .events_input { border-radius: 3px; border-color: #ccc; }
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
- `event_plugin_rsvps` - Signup records; `role` is `trooper` or `wrangler`, unique per
  `(event_id, user_id, role)` so a member can hold both - one signup covering a mix of
  trooping and wrangling days is two rows
- `event_plugin_rsvp_days` - Which days user is attending
- `event_plugin_rsvp_costumes` - Costumes per RSVP
- `event_plugin_troop_reports` - Troop report tracking

## Permissions

- **GEC (Garrison Event Coordinator)**: Can view and manage RSVPs for assigned events from the event page, generate attendance sheets (no Admin CP access required)
- **Admin**: Full access to all features including Admin CP event management
- **Users**: Can view live events, sign up to attend (trooping and/or wrangling), update
  their own signup while signups are open, create troop reports
- **Wranglers**: No membership or TK ID required; may sign up to any event they can see, but
  may not author troop reports

## Development

See the [repository README](../README.md) for the Docker development environment and the
end-to-end test suite.

## Support

For issues or questions, please contact the plugin maintainer.

## License

This plugin is developed for the 501st SCG garrison.
