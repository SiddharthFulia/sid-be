# Reseed city_places (with buildings)

Copy the ONE line under each heading and paste into your SSH session. Every command is a single line so nothing breaks on paste.

## SSH in

```
ssh -i "E:\Siddharth\ssh-key-2026-04-19.key" ubuntu@80.225.213.103
```

## Deploy latest BE code

```
cd /home/ubuntu/sid-be && git pull && pm2 restart all
```

## Dry-run one city (verify shape, no DB writes, ~15s)

```
cd /home/ubuntu/sid-be && node scripts/seedCityPlaces.js mumbai --force --dry-run
```

## Reseed a single city (real writes, ~15-30s each)

```
cd /home/ubuntu/sid-be && node scripts/seedCityPlaces.js mumbai --force
```

```
cd /home/ubuntu/sid-be && node scripts/seedCityPlaces.js bangalore --force
```

```
cd /home/ubuntu/sid-be && node scripts/seedCityPlaces.js delhi --force
```

## Reseed ALL 53 cities under nohup (~14 min, survives SSH drop)

Start it:
```
cd /home/ubuntu/sid-be && nohup node scripts/seedCityPlaces.js --force > /tmp/reseed.log 2>&1 & echo "reseed PID $!"
```

Watch progress live:
```
tail -f /tmp/reseed.log
```

Check if still running:
```
ps -p $(pgrep -f seedCityPlaces) -o pid,etime,cmd 2>/dev/null || echo "reseed finished"
```

Grep only the ok/fail summary lines when done:
```
grep -E "seeded|failed|done" /tmp/reseed.log
```

## Reseed city ROAD GRAPHS (only if graph is stale, otherwise skip)

Same script but for the graphs table — separate from places. Only run if graphs are >30 days old.

```
cd /home/ubuntu/sid-be && nohup node scripts/seedCityGraphs.js --force > /tmp/reseed-graphs.log 2>&1 & echo "graphs PID $!"
```

## Trigger the monthly places cron manually (from your Mac/PC, hits the prod BE)

```
curl -X POST -H "Authorization: Bearer $VAULT_TOKEN" https://api.siddharthfulia.com/api/admin/city-graphs/cron/trigger
```

## Quick city status check (no auth needed)

```
curl -s https://api.siddharthfulia.com/api/city-graphs | jq '.items[] | {slug,node_count,edge_count,updated_at}'
```
