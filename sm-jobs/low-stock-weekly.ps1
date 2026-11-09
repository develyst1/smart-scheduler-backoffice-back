# TASK-919 (REQ-120 R3.7) - the Monday Low-Stock run for the back office.
#
# NOT auto-registered. The OWNER adds the Windows Task Scheduler entry on the server (weekly, Monday, morning; Asia/Bangkok), running this script. The run is idempotent per ISO week,
# so a double fire or a manual re-run the same week posts nothing new; a week with nothing low posts nothing at all.
#
# The service token is the back office's SERVICE_TOKEN (never written in this file): set it for the task as the machine environment variable BB_SERVICE_TOKEN.
# BB_URL defaults to the back office on this box (port 4010). The endpoint is FAIL-CLOSED: no token / a wrong token / an unset SERVICE_TOKEN on the server = 401, nothing runs.
$ErrorActionPreference = "Stop"
$token = $env:BB_SERVICE_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) { Write-Error "BB_SERVICE_TOKEN is not set - refusing to run"; exit 2 }
$base = if ([string]::IsNullOrWhiteSpace($env:BB_URL)) { "http://localhost:4010" } else { $env:BB_URL.TrimEnd("/") }
$result = Invoke-RestMethod -Method Post `
  -Uri "$base/api/v1/internal/jobs/low-stock-weekly" `
  -Headers @{ "X-Service-Token" = $token } `
  -ContentType "application/json" -Body "{}"
$result | ConvertTo-Json -Compress
