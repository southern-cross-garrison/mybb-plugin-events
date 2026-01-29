# Docker Setup for MyBB Event Plugin Testing

This Docker setup provides a complete MyBB testing environment with MySQL database and phpMyAdmin.

## Prerequisites

- Docker
- Docker Compose

## Quick Start

1. **Start the containers:**
   ```bash
   docker-compose up -d
   ```

2. **Access MyBB:**
   - MyBB Forum: http://localhost:8080
   - phpMyAdmin: http://localhost:8081
   - Database Host: `db` (when configuring MyBB)

3. **Install MyBB:**
   - Navigate to http://localhost:8080/install/
   - Follow the installation wizard
   - Database settings:
     - Database Host: `db`
     - Database Name: `mybb`
     - Database Username: `mybb`
     - Database Password: `mybbpassword`
     - Table Prefix: `mybb_` (default)

4. **Install the Plugin:**
   - Copy plugin files from `plugin/inc/plugins/` to `test-forum/inc/plugins/`
   - Or use the volume mount (already configured in docker-compose.yml)
   - Go to Admin CP → Plugins → Activate "Event Management"
   - Configure plugin settings

## Services

- **Web Server**: Apache with PHP 7.4 on port 8080
- **Database**: MySQL 5.7 on port 3306
- **phpMyAdmin**: Database management on port 8081

## Volume Mounts

- `./test-forum` → `/var/www/html` (MyBB files)
- `./plugin/inc/plugins` → `/var/www/html/inc/plugins` (Plugin files - automatically synced)

## Useful Commands

```bash
# Start containers
docker-compose up -d

# Stop containers
docker-compose down

# View logs
docker-compose logs -f web
docker-compose logs -f db

# Access web container shell
docker-compose exec web bash

# Access database
docker-compose exec db mysql -u mybb -pmybbpassword mybb

# Rebuild containers
docker-compose build --no-cache

# Stop and remove volumes (clean slate)
docker-compose down -v
```

## Database Credentials

- **Host**: `db` (from web container) or `localhost` (from host)
- **Database**: `mybb`
- **Username**: `mybb`
- **Password**: `mybbpassword`
- **Root Password**: `rootpassword`

## Troubleshooting

### Permission Issues
If you encounter permission errors, run:
```bash
docker-compose exec web chown -R www-data:www-data /var/www/html
docker-compose exec web chmod -R 755 /var/www/html
docker-compose exec web chmod -R 777 /var/www/html/uploads
docker-compose exec web chmod -R 777 /var/www/html/cache
```

### Plugin Not Appearing
- Ensure plugin files are in `plugin/inc/plugins/` directory
- Check that the volume mount is working: `docker-compose exec web ls -la /var/www/html/inc/plugins/`
- Verify file permissions

### Database Connection Issues
- Ensure the `db` service is running: `docker-compose ps`
- Check database logs: `docker-compose logs db`
- Verify database credentials in MyBB config.php

## Development Workflow

1. Make changes to plugin files in `plugin/inc/plugins/`
2. Changes are automatically reflected in the container (volume mount)
3. Refresh MyBB Admin CP to see changes
4. Use phpMyAdmin to inspect database changes

## Cleanup

To completely remove everything:
```bash
docker-compose down -v
docker system prune -a
```
