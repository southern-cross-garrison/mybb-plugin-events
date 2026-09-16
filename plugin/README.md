# MyBB Event Management Plugin

A comprehensive event management plugin for MyBB 1.8 that replaces thread-based event signups with a structured system featuring RSVP tracking, prerequisite validation, multi-day event support, attendance sheets, and automated troop report generation.

## Features

- **Event Management**: Create, edit, and manage events with status (pending/live/archived)
- **Multi-day Events**: Support for events spanning multiple days
- **RSVP System**: Structured RSVP flow with prerequisite validation
- **Wrangler Signups**: Non-costumed helpers can sign up without being full members
- **Prerequisites**: TK ID, WWCC, mobile number, and emergency contact validation
- **Costume Selection**: Select from user's profile costumes during RSVP
- **Region Filtering**: Filter events by region (Sydney, Hunter, Canberra, Other)
- **Calendar & List Views**: View events in calendar or list format
- **Attendance Sheets**: Generate print-friendly attendance sheets
- **Troop Reports**: Automated troop report generation and posting
- **Automated Reminders**: PM reminders for incomplete troop reports
- **iCal Export**: Export events to calendar applications
- **Thread Integration**: Link events to forum threads

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

## Requirements

- MyBB 1.8.x
- PHP 7.0+
- MySQL/MariaDB
- Custom profile fields must be created in MyBB Admin CP before mapping them

## Custom Profile Fields

Before using the plugin, create the following custom profile fields in MyBB:

1. **Costume Field** (multi-select, or a comma separated text field): User's available costumes
2. **TK ID Field** (text): User's TK ID
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

### RSVP Process

1. Users browse events on the Events page
2. Click on an event to view details
3. Click "RSVP to Event"
4. Complete any missing prerequisites (saved back to the user's profile)
5. Select costumes
6. Select days (multi-day events only; all days are selected by default)
7. Confirm the RSVP

RSVPs close at the event's signup cutoff. Events with no cutoff stay open until the event
ends, so a late signup can still be recorded.

### Wrangler Signups

A wrangler is a non-costumed helper - a partner, friend or handler who assists on the day.
Wranglers are not required to be full members, so they are never asked for a TK ID and never
pick a costume. Anyone who can see the event can sign up to wrangle it.

1. Open the event and click "Sign Up to Wrangle"
2. Complete any missing contact details (mobile, emergency contact, and WWCC if the event
   requires one - all saved back to the profile)
3. Select days (multi-day events only)
4. Confirm

Trooping and wrangling are independent: the same person can RSVP as a trooper *and* sign up
to wrangle the same event, which is why the signup table is keyed on
`(event_id, user_id, role)`.

Wranglers appear in their own section of the troop report, in the coordinator RSVP list and
on the attendance sheet, and are counted separately from troopers everywhere a signup count
is shown. The events listing and the Admin CP event list break the figure down into
troopers and wranglers, so an event with helpers but no costumed attendance reads as
"0 troopers, 1 wrangler" rather than an unexplained zero. They
are not sent troop report reminders, and cannot author a troop report - that is troopers
only, since the report records costumed attendance.

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
/rsvp.php                         # RSVP wizard
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
  `(event_id, user_id, role)` so a member can hold both
- `event_plugin_rsvp_days` - Which days user is attending
- `event_plugin_rsvp_costumes` - Costumes per RSVP
- `event_plugin_troop_reports` - Troop report tracking

## Permissions

- **GEC (Garrison Event Coordinator)**: Can view and manage RSVPs for assigned events from the event page, generate attendance sheets (no Admin CP access required)
- **Admin**: Full access to all features including Admin CP event management
- **Users**: Can view live events, RSVP, sign up to wrangle, create troop reports
- **Wranglers**: No membership or TK ID required; may sign up to any event they can see, but
  may not author troop reports

## Development

See the [repository README](../README.md) for the Docker development environment and the
end-to-end test suite.

## Support

For issues or questions, please contact the plugin maintainer.

## License

This plugin is developed for the 501st SCG garrison.
