# Push dsh-memory-list to your GitHub account. ASCII only on purpose.
# The browser page opened by the .cmd already has the "repo" scope pre-checked.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $MyInvocation.MyCommand.Path)
Write-Host ''
Write-Host '=== dsh-memory-list -> GitHub ==='
Write-Host '[1] Browser opened the "new token" page (repo scope pre-checked).'
Write-Host '[2] Click "Generate token" at the bottom, copy the ghp_... string.'
Write-Host '[3] Paste it here, press Enter.'
Write-Host ''
Write-Host 'PAT (paste then Enter):'
$pat = (Read-Host).Trim()
if ([string]::IsNullOrWhiteSpace($pat)) { Write-Host 'empty token, aborted'; exit 1 }
$h = @{ Authorization = "Bearer $pat"; 'User-Agent' = 'dsh-memory-list-push'; Accept = 'application/vnd.github+json' }
try { $me = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers $h }
catch { Write-Host "token rejected: $($_.Exception.Message)"; exit 1 }
Write-Host "account: $($me.login)"
$repo = 'dsh-memory-list'
try {
  Invoke-RestMethod -Uri "https://api.github.com/repos/$($me.login)/$repo" -Headers $h | Out-Null
  Write-Host "repo exists: https://github.com/$($me.login)/$repo"
} catch {
  $body = @{ name = $repo; description = 'Memory tree - DeepSeek Harness plugin (memory-list)'; private = $false } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri 'https://api.github.com/user/repos' -Headers $h -Body $body -ContentType 'application/json' | Out-Null
  Write-Host "repo created: https://github.com/$($me.login)/$repo"
}
$env:GIT_CONFIG_GLOBAL = 'NUL'
git add -A
git -c user.name="$($me.login)" -c user.email="$($me.id)+$($me.login)@users.noreply.github.com" commit -m 'sync' 2>$null | Out-Null
git push "https://$($me.login):$($pat)@github.com/$($me.login)/$repo.git" HEAD:refs/heads/main
if ($LASTEXITCODE -eq 0) {
  Write-Host ''
  Write-Host "OK: https://github.com/$($me.login)/$repo" -ForegroundColor Green
} else {
  Write-Host "push failed (exit $LASTEXITCODE)" -ForegroundColor Red
}
