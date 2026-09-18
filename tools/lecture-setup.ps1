# RuninqVic 강의 설정 도구
# ElevenLabs 키 / 강의 코드 / 관리자 코드를 창에서 입력받아 Vercel 환경 변수로 등록하고 사이트에 반영합니다.
# - 입력한 키는 이 PC의 파일이나 기록에 남기지 않고 Vercel 명령의 표준 입력으로만 전달합니다.
# - 사이트 반영은 "지금 서비스 중인 버전을 다시 배포"하는 방식이라, 이 PC 폴더의 파일을 올리지 않습니다.
param([switch]$SelfTest, [switch]$DryRun, [switch]$TestRoundTrip, [switch]$TestCheck)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$root = Split-Path -Parent $PSScriptRoot
$siteHost = 'runinqvic.vercel.app'
$siteUrl = "https://$siteHost"
$appTitle = 'RuninqVic 강의 설정'

# full path of the vercel command (never whatever "vercel" happens to resolve to inside the project folder)
$vercelCmd = $null
foreach ($n in @('vercel.cmd', 'vercel.exe', 'vercel')) { $c = Get-Command $n -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $vercelCmd = $c.Source; break } }

# ---------- run a vercel command; an optional secret goes to stdin as UTF-8 without BOM (never on the command line) ----------
function Invoke-Vercel([string]$arguments, [string]$stdinText) {
  if ($DryRun) { return @{ Code = 0; Out = "(연습 모드) vercel $arguments" } }
  if (-not $vercelCmd) { return @{ Code = 127; Out = 'vercel 프로그램을 찾을 수 없습니다.' } }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $env:ComSpec
  $psi.Arguments = '/d /c ""' + $vercelCmd + '" ' + $arguments + ' 2>&1"'
  $psi.WorkingDirectory = $root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi
  # under a UTF-8 console code page .NET would prepend a BOM to the child's stdin: force "no BOM" while starting
  $oldEnc = $null
  try { $oldEnc = [Console]::InputEncoding; [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
  try { [void]$p.Start() } finally { if ($oldEnc) { try { [Console]::InputEncoding = $oldEnc } catch { } } }
  if ($stdinText) {
    $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($stdinText)
    $p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $p.StandardInput.BaseStream.Flush()
  }
  $p.StandardInput.Close()
  $task = $p.StandardOutput.ReadToEndAsync()
  $deadline = (Get-Date).AddMinutes(6)
  while (-not $task.IsCompleted) {
    [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 80
    if ((Get-Date) -gt $deadline) { try { $p.Kill() } catch { }; return @{ Code = 124; Out = '시간이 너무 오래 걸려 중단했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.' } }
  }
  $p.WaitForExit()
  return @{ Code = $p.ExitCode; Out = $task.Result }
}

# what the live site is serving right now (the env store alone does not tell that)
function Get-LiveState {
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $r = Invoke-RestMethod -Uri "$siteUrl/api/music?probe=1" -TimeoutSec 20 -Headers @{ 'Cache-Control' = 'no-cache' }
    return $r
  } catch { return $null }
}
function Write-LiveState($live) {
  if (-not $live) { Log '  (사이트 상태를 확인하지 못했습니다. 잠시 후 [현재 설정 확인]을 눌러 보세요)'; return }
  if ($live.providers.elevenlabs) {
    if ($live.needsCode) { Log "  지금 사이트: 강의용 키 켜짐 · 강의 코드 필요 · 한 곡 최대 $($live.maxSongSeconds)초" }
    else { Log "  지금 사이트: 강의용 키 켜짐 · ⚠ 코드 없이 누구나 사용 가능(공개 모드) · 한 곡 최대 $($live.maxSongSeconds)초" }
  } else { Log '  지금 사이트: 강의용 키 꺼짐 (방문자는 자기 키를 넣어야 작곡할 수 있음)' }
}

# ---------- form ----------
$form = New-Object System.Windows.Forms.Form
$form.Text = $appTitle
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object System.Drawing.Size(620, 690)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font('맑은 고딕', 9.5)
$form.BackColor = [System.Drawing.Color]::FromArgb(250, 250, 252)

$y = 16
function Add-Label([string]$text, [int]$top, [bool]$bold = $false, [int]$height = 20) {
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $text; $l.Left = 20; $l.Top = $top; $l.Width = 580; $l.Height = $height
  if ($bold) { $l.Font = New-Object System.Drawing.Font('맑은 고딕', 10, [System.Drawing.FontStyle]::Bold) }
  else { $l.ForeColor = [System.Drawing.Color]::FromArgb(90, 95, 105) }
  $form.Controls.Add($l); return $l
}
function Add-Box([int]$top, [bool]$masked = $false) {
  $t = New-Object System.Windows.Forms.TextBox
  $t.Left = 20; $t.Top = $top; $t.Width = 580
  if ($masked) { $t.UseSystemPasswordChar = $true }
  $form.Controls.Add($t); return $t
}

[void](Add-Label 'AI 작곡을 수강생이 키 없이 쓸 수 있게 설정합니다' $y $true 24); $y += 28
[void](Add-Label '비워 둔 칸은 바꾸지 않습니다. 저장하면 사이트에 자동으로 반영됩니다(약 1분).' $y); $y += 30

[void](Add-Label '1. ElevenLabs API 키' $y $true); $y += 22
$tbKey = Add-Box $y $true; $y += 28
$cbShow = New-Object System.Windows.Forms.CheckBox
$cbShow.Text = '키 보기'; $cbShow.Left = 20; $cbShow.Top = $y; $cbShow.Width = 90
$cbShow.Add_CheckedChanged({ $tbKey.UseSystemPasswordChar = -not $cbShow.Checked })
$form.Controls.Add($cbShow)
$lnk = New-Object System.Windows.Forms.LinkLabel
$lnk.Text = 'ElevenLabs에서 키 만들기 (Music 권한 + 크레딧 한도를 꼭 설정하세요)'; $lnk.Left = 120; $lnk.Top = $y + 2; $lnk.Width = 480
$lnk.Add_LinkClicked({ Start-Process 'https://elevenlabs.io/app/settings/api-keys' })
$form.Controls.Add($lnk); $y += 32

[void](Add-Label '2. 강의 코드 (4글자 이상)' $y $true); $y += 22
[void](Add-Label '수강생에게 알려 줄 코드입니다. 이 코드를 아는 사람만 선생님 키로 작곡할 수 있습니다.' $y); $y += 22
$tbCode = Add-Box $y; $y += 28
$cbOpen = New-Object System.Windows.Forms.CheckBox
$cbOpen.Text = '코드 없이 누구나 쓰게 하기 (공개 모드 · 권장하지 않음)'; $cbOpen.Left = 20; $cbOpen.Top = $y; $cbOpen.Width = 420
$form.Controls.Add($cbOpen); $y += 32

[void](Add-Label '3. 관리자 코드 (8글자 이상, 선택)' $y $true); $y += 22
[void](Add-Label '앱의 도움말 > 사용량(운영자) 화면을 열 때 쓰는 비밀 코드입니다. 수강생에게는 알려 주지 마세요.' $y); $y += 22
$tbAdmin = Add-Box $y $true; $y += 36

[void](Add-Label '4. 한 곡 최대 길이(초)' $y $true); $y += 24
$numMax = New-Object System.Windows.Forms.NumericUpDown
$numMax.Left = 20; $numMax.Top = $y; $numMax.Width = 90; $numMax.Minimum = 30; $numMax.Maximum = 300; $numMax.Increment = 30; $numMax.Value = 120
$form.Controls.Add($numMax)
$cbMax = New-Object System.Windows.Forms.CheckBox
$cbMax.Text = '이 값으로 바꾸기 (기본 120초)'; $cbMax.Left = 124; $cbMax.Top = $y; $cbMax.Width = 300
$form.Controls.Add($cbMax); $y += 40

$btnSave = New-Object System.Windows.Forms.Button
$btnSave.Text = '저장하고 사이트에 반영'; $btnSave.Left = 20; $btnSave.Top = $y; $btnSave.Width = 200; $btnSave.Height = 36
$btnSave.BackColor = [System.Drawing.Color]::FromArgb(255, 106, 31); $btnSave.ForeColor = [System.Drawing.Color]::White; $btnSave.FlatStyle = 'Flat'
$form.Controls.Add($btnSave)
$btnCheck = New-Object System.Windows.Forms.Button
$btnCheck.Text = '현재 설정 확인'; $btnCheck.Left = 230; $btnCheck.Top = $y; $btnCheck.Width = 130; $btnCheck.Height = 36
$form.Controls.Add($btnCheck)
$btnEnd = New-Object System.Windows.Forms.Button
$btnEnd.Text = '강의 종료 (키 지우기)'; $btnEnd.Left = 370; $btnEnd.Top = $y; $btnEnd.Width = 160; $btnEnd.Height = 36
$form.Controls.Add($btnEnd)
$btnClose = New-Object System.Windows.Forms.Button
$btnClose.Text = '닫기'; $btnClose.Left = 540; $btnClose.Top = $y; $btnClose.Width = 60; $btnClose.Height = 36
$btnClose.Add_Click({ $form.Close() })
$form.Controls.Add($btnClose); $y += 46

$log = New-Object System.Windows.Forms.TextBox
$log.Left = 20; $log.Top = $y; $log.Width = 580; $log.Height = ($form.ClientSize.Height - $y - 16)
$log.Multiline = $true; $log.ReadOnly = $true; $log.ScrollBars = 'Vertical'; $log.BackColor = [System.Drawing.Color]::White
$form.Controls.Add($log)

$script:busy = $false
$script:noPrompt = [bool]$TestCheck   # developer checks must never stop on a dialog
function Log([string]$msg) { $log.AppendText($msg + "`r`n"); [System.Windows.Forms.Application]::DoEvents() }
function Set-Busy([bool]$b) { $script:busy = $b; foreach ($x in @($btnSave, $btnCheck, $btnEnd, $btnClose)) { $x.Enabled = -not $b }; $form.Cursor = $(if ($b) { 'WaitCursor' } else { 'Default' }) }
$form.Add_FormClosing({ param($s, $e) if ($script:busy) { $e.Cancel = $true; [void][System.Windows.Forms.MessageBox]::Show('작업이 끝날 때까지 잠시만 기다려 주세요.', $appTitle) } })

# opens a console window running "vercel login": the user approves in the browser, this tool never sees the password
function Start-VercelLogin {
  if ($script:noPrompt) { return $false }
  $msg = "이 PC에서 Vercel 로그인이 필요합니다. (처음 한 번만)`r`n`r`n[예]를 누르면 검은 창과 브라우저가 열립니다.`r`n1) 브라우저에서 RuninqVic을 배포한 Vercel 계정으로 로그인하고 승인합니다.`r`n2) 검은 창에 완료 표시가 나오면 아무 키나 눌러 창을 닫습니다.`r`n3) 그러면 하던 작업을 이어서 진행합니다.`r`n`r`n지금 로그인할까요?"
  if ([System.Windows.Forms.MessageBox]::Show($msg, $appTitle, 'YesNo', 'Information') -ne 'Yes') { return $false }
  Log '· 로그인 창을 열었습니다. 브라우저에서 승인한 뒤 검은 창에서 아무 키나 눌러 주세요…'
  try { $p = Start-Process -FilePath $env:ComSpec -ArgumentList ('/d /c ""' + $vercelCmd + '" login & echo. & pause"') -WorkingDirectory $root -PassThru }
  catch { Log ('  로그인 창을 열지 못했습니다: ' + $_.Exception.Message); return $false }
  $deadline = (Get-Date).AddMinutes(15)
  while (-not $p.HasExited) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 150; if ((Get-Date) -gt $deadline) { Log '  로그인 시간이 너무 오래 걸려 중단했습니다.'; return $false } }
  return $true
}
function Test-Ready {
  if (-not $vercelCmd) { Log '⚠ vercel 프로그램이 설치되어 있지 않습니다. (Node.js 설치 후 명령 프롬프트에서 npm i -g vercel)'; return $false }
  if (-not (Test-Path (Join-Path $root '.vercel\project.json'))) { Log '⚠ 이 폴더가 Vercel 프로젝트와 연결되어 있지 않습니다. (RuninqVic을 배포한 PC의 폴더에서 실행해 주세요)'; return $false }
  $who = Invoke-Vercel 'whoami' $null
  if ($who.Code -ne 0 -and $who.Out -match 'credentials|vercel login|not authenticated|token') {
    # first use on this PC (or the login expired): let the user sign in through the browser, then carry on
    Log '이 PC에서 Vercel 로그인이 필요합니다.'
    if (Start-VercelLogin) { $who = Invoke-Vercel 'whoami' $null }
  }
  if ($who.Code -ne 0) { Log '⚠ Vercel에 로그인되어 있지 않습니다. 버튼을 다시 누르면 로그인 창을 열 수 있습니다.'; Log $who.Out.Trim(); return $false }
  Log ('Vercel 계정: ' + (($who.Out -split "`n") | Where-Object { $_.Trim() -and $_ -notmatch 'Vercel CLI' } | Select-Object -Last 1).Trim())
  return $true
}
# names registered for production, or $null when the list could not be read
function Get-EnvNames {
  $r = Invoke-Vercel 'env ls production' $null
  if ($r.Code -ne 0) { Log '⚠ 설정을 읽지 못했습니다(등록 여부를 알 수 없음). 잠시 후 다시 시도해 주세요.'; Log $r.Out.Trim(); return $null }
  $found = @()
  foreach ($n in @('ELEVENLABS_API_KEY', 'LECTURE_CODE', 'LECTURE_OPEN', 'ADMIN_CODE', 'LECTURE_MAX_SECONDS', 'LECTURE_RATE_PER_10MIN')) { if ($r.Out -match ('(?m)^\s*' + [regex]::Escape($n) + '\s')) { $found += $n } }
  return ,$found
}
function Set-EnvVar([string]$name, [string]$value) {
  Log "· $name 등록 중…"
  $r = Invoke-Vercel "env add $name production --force -y" $value
  if ($r.Code -ne 0) { Log ('  실패: ' + $r.Out.Trim()); return $false }
  Log '  완료'; return $true
}
# 0 = removed, 1 = was not registered, 2 = failed
function Remove-EnvVar([string]$name) {
  Log "· $name 지우는 중…"
  $r = Invoke-Vercel "env rm $name production -y" $null
  if ($r.Code -eq 0) { Log '  완료'; return 0 }
  if ($r.Out -match 'not found|does not exist|No Environment Variable') { Log '  (등록되어 있지 않음)'; return 1 }
  Log ('  실패: ' + $r.Out.Trim()); return 2
}
# apply env changes by rebuilding the deployment that is live now - local files are NOT uploaded
function Publish-Site {
  Log '· 사이트에 반영하는 중… (30초~1분)'
  $r = Invoke-Vercel "redeploy $siteHost --target production" $null
  if ($r.Code -ne 0) { Log ('  반영 실패: ' + $r.Out.Trim()); return $false }
  Log "  반영 완료: $siteUrl"; return $true
}

$btnSave.Add_Click({
  $key = ($tbKey.Text -replace '\s', ''); $code = $tbCode.Text.Trim(); $admin = $tbAdmin.Text.Trim()
  if (-not $key -and -not $code -and -not $admin -and -not $cbMax.Checked -and -not $cbOpen.Checked) { [void][System.Windows.Forms.MessageBox]::Show('바꿀 내용을 하나 이상 입력해 주세요.', $appTitle); return }
  if ($key -and ($key.Length -lt 20 -or $key -notmatch '^[\x21-\x7E]+$')) { [void][System.Windows.Forms.MessageBox]::Show('API 키 형식이 올바르지 않습니다. ElevenLabs에서 복사한 키 전체를 붙여넣어 주세요.', $appTitle); return }
  if ($code -and $code.Length -lt 4) { [void][System.Windows.Forms.MessageBox]::Show('강의 코드는 4글자 이상으로 정해 주세요.', $appTitle); return }
  if ($admin -and $admin.Length -lt 8) { [void][System.Windows.Forms.MessageBox]::Show('관리자 코드는 8글자 이상으로 정해 주세요. (다른 사람이 추측하기 어렵게)', $appTitle); return }
  if ($admin -and $code -and $admin -eq $code) { [void][System.Windows.Forms.MessageBox]::Show('관리자 코드는 강의 코드와 다르게 정해 주세요.', $appTitle); return }
  if ($cbOpen.Checked -and $code) { [void][System.Windows.Forms.MessageBox]::Show('강의 코드를 넣었으면 공개 모드 체크는 풀어 주세요.', $appTitle); return }
  if ($cbOpen.Checked) {
    $warn = "공개 모드에서는 사이트 주소를 아는 누구나 선생님의 ElevenLabs 크레딧으로 작곡할 수 있습니다.`r`n(같은 사람 10분에 5곡, 같은 접속 위치 10분에 6곡으로만 제한됩니다)`r`n`r`n정말 코드 없이 열까요?"
    if ([System.Windows.Forms.MessageBox]::Show($warn, $appTitle, 'YesNo', 'Warning', 'Button2') -ne 'Yes') { return }
  }
  Set-Busy $true
  try {
    $log.Clear(); if ($DryRun) { Log '※ 연습 모드: 실제로 등록하지 않습니다.' }
    if (-not $DryRun) {
      if (-not (Test-Ready)) { return }
      $names = Get-EnvNames; if ($null -eq $names) { return }
      $willHaveCode = [bool]$code -or ($names -contains 'LECTURE_CODE')
      if ($key -and -not $willHaveCode -and -not $cbOpen.Checked -and -not ($names -contains 'LECTURE_OPEN')) {
        [void][System.Windows.Forms.MessageBox]::Show("강의 코드가 없으면 키를 등록해도 사이트에서 쓰이지 않습니다.`r`n2번 칸에 강의 코드를 넣어 주세요. (코드 없이 열려면 공개 모드를 체크)", $appTitle); return
      }
    }
    $ok = $true
    if ($key)   { $ok = (Set-EnvVar 'ELEVENLABS_API_KEY' $key) -and $ok }
    if ($code)  { $ok = (Set-EnvVar 'LECTURE_CODE' $code) -and $ok; if ($ok -and -not $DryRun -and ($names -contains 'LECTURE_OPEN')) { [void](Remove-EnvVar 'LECTURE_OPEN') } }
    if ($cbOpen.Checked) { $ok = (Set-EnvVar 'LECTURE_OPEN' '1') -and $ok }
    if ($admin) { $ok = (Set-EnvVar 'ADMIN_CODE' $admin) -and $ok }
    if ($cbMax.Checked) { $ok = (Set-EnvVar 'LECTURE_MAX_SECONDS' ([string][int]$numMax.Value)) -and $ok }
    if (-not $ok) { Log '일부 항목을 등록하지 못했습니다. 위 메시지를 확인해 주세요. (사이트에는 아직 반영하지 않았습니다)'; return }
    if (Publish-Site) {
      $tbKey.Clear(); $cbShow.Checked = $false
      if (-not $DryRun) { Write-LiveState (Get-LiveState) }
      Log ''
      Log '끝났습니다. 수강생 안내:'
      Log "  1) $siteUrl 접속 → 배경음악의 [AI] 버튼"
      if ($code) { Log "  2) 강의 코드 칸에 '$code' 입력 후 가사·분위기를 적고 [만들기]" } else { Log '  2) (강의 코드가 있다면 입력하고) 가사·분위기를 적고 [만들기]' }
      Log "사용량 보기: $siteUrl/#usage 를 열고 관리자 코드를 넣으세요. (앱 오른쪽 위 [도움말] 창 맨 아래의 [사용량(운영자)] 버튼과 같습니다)"
    } else { Log '⚠ 설정은 저장됐지만 사이트에는 아직 반영되지 않았습니다. 잠시 후 다시 [저장하고 사이트에 반영]을 눌러 주세요(같은 값을 다시 넣어도 됩니다).' }
  } finally { Set-Busy $false }
})

$btnCheck.Add_Click({
  Set-Busy $true
  try {
    $log.Clear(); if (-not (Test-Ready)) { return }
    $names = Get-EnvNames; if ($null -eq $names) { return }
    foreach ($n in @('ELEVENLABS_API_KEY', 'LECTURE_CODE', 'LECTURE_OPEN', 'ADMIN_CODE', 'LECTURE_MAX_SECONDS')) { if ($names -contains $n) { Log "✔ $n : 등록됨 (값은 보이지 않습니다)" } else { Log "– $n : 없음" } }
    Write-LiveState (Get-LiveState)
  } finally { Set-Busy $false }
})

$btnEnd.Add_Click({
  $a = [System.Windows.Forms.MessageBox]::Show("서버에 등록한 ElevenLabs 키를 지웁니다.`r`n이후에는 수강생이 선생님 키로 작곡할 수 없습니다. (강의 코드와 관리자 코드는 그대로 둡니다)`r`n`r`n계속할까요?", $appTitle, 'YesNo', 'Question')
  if ($a -ne 'Yes') { return }
  Set-Busy $true
  try {
    $log.Clear(); if (-not $DryRun -and -not (Test-Ready)) { return }
    $r = Remove-EnvVar 'ELEVENLABS_API_KEY'
    if ($r -eq 2) { Log '⚠ 키를 지우지 못했습니다. 키가 아직 사이트에서 동작 중입니다. 다시 시도하거나, 지금 바로 ElevenLabs 사이트에서 그 키를 삭제하세요.'; return }
    [void](Remove-EnvVar 'LECTURE_OPEN')
    if (-not (Publish-Site)) { Log '⚠ 설정에서는 지웠지만 사이트에는 아직 반영되지 않아, 키가 계속 동작 중일 수 있습니다. 다시 눌러 보거나 ElevenLabs 사이트에서 그 키를 삭제하세요.'; return }
    $live = if ($DryRun) { $null } else { Get-LiveState }
    if ($live -and $live.providers.elevenlabs) { Log '⚠ 사이트가 아직 강의용 키를 쓰고 있습니다. 1분 뒤 [현재 설정 확인]으로 다시 확인하고, 계속 켜져 있으면 ElevenLabs 사이트에서 키를 삭제하세요.' }
    else { Write-LiveState $live; Log '강의용 키를 내렸습니다. ElevenLabs 사이트에서 그 키 자체를 삭제하면 더 안전합니다.' }
  } finally { Set-Busy $false }
})

if ($TestRoundTrip) {
  # developer check: send a value through the same stdin path to the (non-sensitive) development environment, read it back, then remove it
  $val = 'sk_테스트-값_123 끝'
  $r1 = Invoke-Vercel 'env add RV_TOOL_TEST development --force -y' $val
  $tmp = Join-Path $env:TEMP ('rv_env_' + [guid]::NewGuid().ToString('N') + '.txt')
  $r2 = Invoke-Vercel ('env pull "' + $tmp + '" --environment=development --yes') $null
  $got = ''
  if (Test-Path $tmp) { $line = Get-Content -LiteralPath $tmp -Encoding UTF8 | Where-Object { $_ -like 'RV_TOOL_TEST=*' } | Select-Object -First 1; if ($line) { $got = ($line -replace '^RV_TOOL_TEST=', '').Trim('"') }; Remove-Item -LiteralPath $tmp -Force }
  $r3 = Invoke-Vercel 'env rm RV_TOOL_TEST development -y' $null
  $firstBytes = ([System.Text.Encoding]::UTF8.GetBytes($got) | Select-Object -First 3 | ForEach-Object { $_.ToString('x2') }) -join ''
  Write-Output ('add=' + $r1.Code + ' pull=' + $r2.Code + ' rm=' + $r3.Code + ' match=' + ($got -eq $val) + ' gotLen=' + $got.Length + ' wantLen=' + $val.Length + ' firstBytes=' + $firstBytes + ' vercel=' + [bool]$vercelCmd)
  $form.Dispose(); exit 0
}
if ($TestCheck) {
  # developer check: the read-only paths against the real CLI (login, env list parsing, live probe, "not registered" detection)
  $form.CreateControl()
  $ready = Test-Ready; $names = Get-EnvNames; Write-LiveState (Get-LiveState)
  $rm = Remove-EnvVar 'RV_TOOL_DOES_NOT_EXIST'
  Write-Output ('ready=' + $ready + ' names=[' + ($names -join ',') + '] namesIsNull=' + ($null -eq $names) + ' rmMissing=' + $rm)
  Write-Output $log.Text
  $form.Dispose(); exit 0
}
if ($SelfTest) { $form.CreateControl(); Write-Output ('SELFTEST OK controls=' + $form.Controls.Count + ' vercel=' + [bool]$vercelCmd); $form.Dispose(); exit 0 }
[void]$form.ShowDialog()
