<?php
/**
 * MyBB Event Plugin - Regions run by another unit
 *
 * A garrison serves its own territory, but members living near a border troop at the
 * neighbouring garrison's events too, and those are cross-posted here so members can sign
 * up as usual. A region can therefore name the unit that runs it - another garrison - and
 * carry that unit's logo. Every event filed under such a region says that this is not the
 * real signup sheet and links to the one that is (the event's `external_signup_url`).
 *
 * Nothing else about the event changes: it is signed up to, reminded about, reported on
 * and counted exactly like one of the garrison's own.
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";

// A unit's name is shown in a sentence, not filed anywhere, so this is only a sanity cap.
define('EVENTS_UNIT_NAME_MAX_LENGTH', 100);
define('EVENTS_UNIT_LOGO_MAX_BYTES', 1048576);
// The event column is varchar(255).
define('EVENTS_SIGNUP_URL_MAX_LENGTH', 255);

/**
 * The regions run by another unit, as the settings page saved them.
 *
 * Stored as JSON in one setting rather than as Region=value pairs like the forum map,
 * because a unit's name is free text and may well contain a comma. Keyed by region name,
 * so it is re-keyed whenever a region is renamed or deleted - see events_admin_regions.php.
 * A region missing from the map, or with no unit, is the garrison's own.
 *
 * @return array region => array('unit' => string, 'logo' => string path from the board root)
 */
function events_region_units()
{
    $stored = json_decode((string)events_get_setting('region_units'), true);
    if(!is_array($stored))
    {
        return array();
    }

    $units = array();
    foreach($stored as $region => $entry)
    {
        if(!is_array($entry))
        {
            continue;
        }

        $unit = isset($entry['unit']) && is_string($entry['unit']) ? trim($entry['unit']) : '';
        $logo = isset($entry['logo']) && is_string($entry['logo']) ? trim($entry['logo']) : '';

        if((string)$region !== '' && ($unit !== '' || $logo !== ''))
        {
            $units[(string)$region] = array('unit' => $unit, 'logo' => $logo);
        }
    }

    return $units;
}

/**
 * Turn a region => unit map back into the setting's stored form.
 *
 * @param array $units region => array('unit' => string, 'logo' => string)
 * @return string
 */
function events_build_region_units_setting(array $units)
{
    $stored = array();

    foreach($units as $region => $entry)
    {
        $unit = isset($entry['unit']) ? trim((string)$entry['unit']) : '';
        $logo = isset($entry['logo']) ? trim((string)$entry['logo']) : '';

        if((string)$region !== '' && ($unit !== '' || $logo !== ''))
        {
            $stored[(string)$region] = array('unit' => $unit, 'logo' => $logo);
        }
    }

    return $stored ? json_encode($stored) : '';
}

/**
 * The unit running a region, or null when the garrison runs it itself.
 *
 * @param string $region
 * @return array|null array('unit' => string, 'logo' => string)
 */
function events_region_unit($region)
{
    $units = events_region_units();
    $region = (string)$region;

    if($region === '' || !isset($units[$region]) || $units[$region]['unit'] === '')
    {
        return null;
    }

    return $units[$region];
}

/**
 * The regions on the list that another unit runs. The event forms only ask for a signup
 * sheet when there are some, and only while one of them is chosen.
 *
 * @return array of string
 */
function events_unit_regions()
{
    $regions = array();

    foreach(events_regions() as $region)
    {
        if(events_region_unit($region) !== null)
        {
            $regions[] = $region;
        }
    }

    return $regions;
}

/**
 * What an event run by another unit needs to say so.
 *
 * @param array $event Event row
 * @return array|null array('unit' => string, 'logo_url' => string, 'signup_url' => string),
 *         either URL '' when there is none; null for the garrison's own events
 */
function events_event_unit(array $event)
{
    $unit = events_region_unit(isset($event['region']) ? $event['region'] : '');
    if($unit === null)
    {
        return null;
    }

    return array(
        'unit'       => $unit['unit'],
        'logo_url'   => events_unit_logo_url($unit['logo']),
        // Read defensively: a board that has not run the upgrade adding it has no column.
        'signup_url' => isset($event['external_signup_url']) ? trim((string)$event['external_signup_url']) : '',
    );
}

/**
 * The address a stored logo is served from.
 *
 * @param string $path From the board root, as events_store_unit_logo() returns it
 * @return string '' for none
 */
function events_unit_logo_url($path)
{
    global $mybb;

    $path = trim((string)$path);
    if($path === '')
    {
        return '';
    }

    return rtrim($mybb->settings['bburl'], '/') . '/' . ltrim($path, '/');
}

/**
 * Whether a signup sheet address is one the plugin will link to: a web address, and one
 * that can sit inside an href and a BBCode [url=] without escaping out of either.
 *
 * @param string $url
 * @return bool
 */
function events_valid_signup_url($url)
{
    $url = (string)$url;

    return my_strlen($url) <= EVENTS_SIGNUP_URL_MAX_LENGTH
        && preg_match('#^https?://[^\s/?\#]+#i', $url)
        && !preg_match('#[\s"\'<>\[\]\\\\]#', $url)
        && filter_var($url, FILTER_VALIDATE_URL) !== false;
}

/**
 * The warning that this is not the real signup sheet, for the event card and the last
 * step of signing up.
 *
 * @param array $event Event row
 * @param string $id Element id
 * @return string HTML, '' for the garrison's own events
 */
function events_unit_notice_html(array $event, $id)
{
    $unit = events_event_unit($event);
    if($unit === null)
    {
        return '';
    }

    $html = '<p class="events_notice events_unit_notice" id="' . htmlspecialchars_uni($id) . '">'
        . 'This event is run by <strong class="events_unit_name">' . htmlspecialchars_uni($unit['unit']) . '</strong>.'
        . ' Signing up here doesn\'t sign you up with them';

    if($unit['signup_url'] !== '')
    {
        // A new tab: on the signup form, following it in place would throw away the
        // answers given so far.
        $html .= ': <a href="' . htmlspecialchars_uni($unit['signup_url']) . '" class="events_unit_signup_link"'
            . ' target="_blank" rel="noopener noreferrer">sign up on their signup sheet</a> too.';
    }
    else
    {
        $html .= '.';
    }

    return $html . '</p>';
}

/**
 * The unit's logo for the event card, or nothing.
 *
 * @param array $event Event row
 * @return string HTML
 */
function events_unit_logo_html(array $event)
{
    $unit = events_event_unit($event);
    if($unit === null || $unit['logo_url'] === '')
    {
        return '';
    }

    return '<img src="' . htmlspecialchars_uni($unit['logo_url']) . '" class="event_unit_logo" id="event_unit_logo"'
        . ' alt="' . htmlspecialchars_uni($unit['unit']) . '" title="' . htmlspecialchars_uni($unit['unit']) . '" />';
}

/**
 * Where uploaded logos live, relative to the board root: an events folder in the board's
 * uploads directory. A board whose uploads path is absolute has nothing to serve it from
 * that this can work out, so it falls back to MyBB's default.
 *
 * @return string no leading or trailing slash
 */
function events_unit_logo_dir()
{
    global $mybb;

    $uploads = isset($mybb->settings['uploadspath']) ? trim((string)$mybb->settings['uploadspath']) : '';
    $uploads = preg_replace('#^\./+#', '', $uploads);

    if($uploads === '' || $uploads[0] === '/' || strpos($uploads, '..') !== false || preg_match('#^[a-z]+:#i', $uploads))
    {
        $uploads = 'uploads';
    }

    return trim($uploads, '/') . '/events';
}

/**
 * Whether a path names a logo this plugin stored, and so is one it may delete. Anything
 * else - a hand-edited setting pointing at the theme's images, say - is left alone.
 *
 * @param string $path
 * @return bool
 */
function events_is_unit_logo_path($path)
{
    return (bool)preg_match('#^(?:[A-Za-z0-9_-]+/)+events/unit_[0-9a-f]{16,}\.(?:png|jpe?g|gif|webp|svg)$#', (string)$path)
        && strpos((string)$path, '..') === false;
}

/**
 * Delete a stored logo. Quietly does nothing for a path it did not store or that is
 * already gone.
 *
 * @param string $path
 */
function events_delete_unit_logo($path)
{
    if(events_is_unit_logo_path($path) && is_file(MYBB_ROOT . $path))
    {
        @unlink(MYBB_ROOT . $path);
    }
}

/**
 * Delete every logo this plugin stored, for uninstall.
 */
function events_delete_all_unit_logos()
{
    $dir = MYBB_ROOT . events_unit_logo_dir();

    foreach((array)glob($dir . '/unit_*') as $file)
    {
        if(is_string($file) && events_is_unit_logo_path(events_unit_logo_dir() . '/' . basename($file)))
        {
            @unlink($file);
        }
    }
}

/**
 * Why an SVG cannot be used as a logo, or '' when it can.
 *
 * An uploaded SVG is served from the board's own domain, and opened directly rather than
 * through an <img> it runs any script it carries with the board's cookies. Only admins
 * upload these, but a logo is the kind of file that gets downloaded from somebody else's
 * site, so anything able to run script or reach out is refused rather than cleaned up.
 *
 * @param string $contents
 * @return string
 */
function events_unit_svg_error($contents)
{
    if(!preg_match('#<svg[\s>]#i', $contents))
    {
        return "is not an SVG image";
    }

    if(preg_match('#<\s*(?:script|foreignObject|iframe|embed|object)\b#i', $contents)
        || preg_match('#<!ENTITY#i', $contents)
        || preg_match('#\son[a-z]+\s*=#i', $contents)
        || preg_match('#javascript\s*:#i', $contents))
    {
        return "contains a script, which an uploaded logo cannot";
    }

    // Links within the file and embedded images are fine; anything else would have the
    // logo fetch from, or send a viewer to, another site.
    if(preg_match_all('#(?:xlink:)?href\s*=\s*["\']\s*([^"\']*)#i', $contents, $matches))
    {
        foreach($matches[1] as $href)
        {
            if($href !== '' && $href[0] !== '#' && stripos($href, 'data:image/') !== 0)
            {
                return "links to another file, which an uploaded logo cannot";
            }
        }
    }

    return '';
}

/**
 * Check and keep an uploaded logo.
 *
 * Each upload gets a name of its own rather than one per region, so a browser holding the
 * old logo in its cache never shows it in place of the new one.
 *
 * @param array $file One entry of $_FILES
 * @param string $label What to call it in an error ("Hunter's logo")
 * @param array $errors Appended to
 * @return string the stored path from the board root, or '' when nothing was stored
 */
function events_store_unit_logo(array $file, $label, array &$errors)
{
    $error = isset($file['error']) ? (int)$file['error'] : UPLOAD_ERR_NO_FILE;
    if($error === UPLOAD_ERR_NO_FILE)
    {
        return '';
    }

    $name = isset($file['name']) ? (string)$file['name'] : '';
    $tmp = isset($file['tmp_name']) ? (string)$file['tmp_name'] : '';
    $size = isset($file['size']) ? (int)$file['size'] : 0;

    if($error === UPLOAD_ERR_INI_SIZE || $error === UPLOAD_ERR_FORM_SIZE || $size > EVENTS_UNIT_LOGO_MAX_BYTES)
    {
        $errors[] = $label . " is too big - 1 MB at most.";
        return '';
    }

    if($error !== UPLOAD_ERR_OK || $tmp === '' || !is_uploaded_file($tmp))
    {
        $errors[] = $label . " could not be uploaded. Please try again.";
        return '';
    }

    $extension = strtolower(pathinfo($name, PATHINFO_EXTENSION));
    if($extension === 'jpeg')
    {
        $extension = 'jpg';
    }

    // What the file really is, read from the file rather than from its name.
    $types = array(
        'png'  => IMAGETYPE_PNG,
        'jpg'  => IMAGETYPE_JPEG,
        'gif'  => IMAGETYPE_GIF,
        'webp' => defined('IMAGETYPE_WEBP') ? IMAGETYPE_WEBP : -1,
    );

    if($extension === 'svg')
    {
        $problem = events_unit_svg_error((string)file_get_contents($tmp));
        if($problem !== '')
        {
            $errors[] = $label . " " . $problem . ".";
            return '';
        }
    }
    elseif(isset($types[$extension]))
    {
        $image = @getimagesize($tmp);
        if(!$image || (int)$image[2] !== $types[$extension])
        {
            $errors[] = $label . " is not a " . strtoupper($extension) . " image.";
            return '';
        }
    }
    else
    {
        $errors[] = $label . " must be a PNG, JPEG, GIF, WebP or SVG image.";
        return '';
    }

    $dir = events_unit_logo_dir();
    $target_dir = MYBB_ROOT . $dir;

    if(!is_dir($target_dir))
    {
        @mkdir($target_dir, 0755, true);
        // MyBB's own upload folders carry an empty index so the folder cannot be listed.
        @file_put_contents($target_dir . '/index.html', "<html>\n<head>\n<title></title>\n</head>\n<body>\n&nbsp;\n</body>\n</html>");
    }

    $path = $dir . '/unit_' . bin2hex(random_bytes(8)) . '.' . $extension;

    if(!is_dir($target_dir) || !@move_uploaded_file($tmp, MYBB_ROOT . $path))
    {
        $errors[] = $label . " could not be saved: the folder " . htmlspecialchars_uni($dir) . " is not writable.";
        return '';
    }

    @chmod(MYBB_ROOT . $path, 0644);

    return $path;
}
