# MyBB Event Management Plugin

A comprehensive event management plugin for MyBB 1.8 that replaces thread-based event signups with a structured system featuring RSVP tracking, prerequisite validation, multi-day event support, attendance sheets, and automated troop report generation.

## Features

- **Event Management**: Create, edit, and manage events with status (pending/live/archived)
- **Multi-day Events**: Support for events spanning multiple days
- **RSVP System**: Structured RSVP flow with prerequisite validation
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

1. Upload all files to your MyBB installation maintaining the directory structure
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

1. **Costume Field** (multi-select): User's available costumes
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
4. Complete prerequisites if needed
5. Select costumes
6. Select days (for multi-day events)
7. Confirm RSVP

### GEC Event Management

GECs can manage events and RSVPs directly from the event page (no Admin CP access required):

1. **Viewing RSVPs**: 
   - Navigate to an event you're managing
   - Click "View RSVPs" in the GEC Controls section
   - Filter by costume or day as needed

2. **Attendance Sheets**:
   - Click "View Attendance Sheet" in the GEC Controls section
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
/inc/plugins/
  events.php                    # Main plugin file
  /events/
    /inc/
      events_install.php        # Database installation
      events_uninstall.php      # Database cleanup
      events_functions.php      # Core helper functions
      events_hooks.php          # MyBB hooks registration
      events_tasks.php          # Automated tasks
    /admin/
      events_admin.php          # Admin CP module
      events_admin_settings.php # Plugin settings
      events_admin_events.php   # Event CRUD management
      events_admin_rsvps.php    # RSVP management
    /events.php                 # Main events page
    /event.php                  # Single event view
    /rsvp.php                   # RSVP flow handler
    /attendance.php             # Attendance sheet generation
    /troop_report.php           # Troop report creation
    /ical.php                   # iCal export
    /templates/
      events_calendar.html      # Calendar view template
      events_list.html          # List view template
      event_view.html           # Event detail template
      rsvp_form.html            # RSVP form template
      rsvp_prerequisites.html   # Prerequisites form
      rsvp_confirm.html         # RSVP confirmation
      attendance_sheet.html     # Attendance sheet template
      troop_report_draft.html   # Troop report draft template
```

## Database Tables

All tables use the `mybb_event_plugin_` prefix:

- `event_plugin_events` - Main events table
- `event_plugin_event_days` - Multi-day event support
- `event_plugin_event_exclusions` - Users excluded from RSVPing
- `event_plugin_rsvps` - RSVP records
- `event_plugin_rsvp_days` - Which days user is attending
- `event_plugin_rsvp_costumes` - Costumes per RSVP
- `event_plugin_troop_reports` - Troop report tracking

## Permissions

- **GEC (Garrison Event Coordinator)**: Can view and manage RSVPs for assigned events from the event page, generate attendance sheets (no Admin CP access required)
- **Admin**: Full access to all features including Admin CP event management
- **Users**: Can view live events, RSVP, create troop reports

## Support

For issues or questions, please contact the plugin maintainer.

## License

This plugin is developed for the 501st SCG garrison.
