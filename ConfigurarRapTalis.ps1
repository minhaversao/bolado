Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference='Stop'

$AppDir=Join-Path $env:APPDATA 'RapTalisPublisher'
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
$ConfigPath=Join-Path $AppDir 'config.json'

function Protect($s){
  if(!$s){return ''}
  ConvertFrom-SecureString (ConvertTo-SecureString $s -AsPlainText -Force)
}
function Unprotect($s){
  if(!$s){return ''}
  $x=ConvertTo-SecureString $s
  $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($x)
  try{[Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}
}
function LoadCfg(){
  if(!(Test-Path $ConfigPath)){
    return [pscustomobject]@{githubToken='';metaToken='';igUserId='';shareToFeed=$true}
  }
  $r=Get-Content $ConfigPath -Raw | ConvertFrom-Json
  [pscustomobject]@{
    githubToken=(Unprotect $r.githubToken)
    metaToken=(Unprotect $r.metaToken)
    igUserId=$r.igUserId
    shareToFeed=[bool]$r.shareToFeed
  }
}
function SaveCfg($g,$old){
  @{
    githubToken=(Protect $g)
    metaToken=(Protect $old.metaToken)
    igUserId=$old.igUserId
    shareToFeed=$old.shareToFeed
  } | ConvertTo-Json | Set-Content $ConfigPath -Encoding UTF8
}

$old=LoadCfg
$form=New-Object Windows.Forms.Form
$form.Text='Configurar GitHub - Rap Talis Publisher'
$form.Size=New-Object Drawing.Size(620,300)
$form.StartPosition='CenterScreen'
$form.FormBorderStyle='FixedDialog'
$form.MaximizeBox=$false

$title=New-Object Windows.Forms.Label
$title.Text='CONECTAR GITHUB'
$title.Font=New-Object Drawing.Font('Segoe UI',16,[Drawing.FontStyle]::Bold)
$title.AutoSize=$true
$title.Location='22,20'
$form.Controls.Add($title)

$desc=New-Object Windows.Forms.Label
$desc.Text='Cole abaixo o token Fine-grained que vc acabou de criar para o repositorio minhaversao/bolado.'
$desc.Location='24,58'
$desc.Size='550,40'
$form.Controls.Add($desc)

$label=New-Object Windows.Forms.Label
$label.Text='GitHub token'
$label.Location='24,106'
$label.AutoSize=$true
$form.Controls.Add($label)

$token=New-Object Windows.Forms.TextBox
$token.Location='24,130'
$token.Size='550,28'
$token.UseSystemPasswordChar=$true
$token.Text=$old.githubToken
$form.Controls.Add($token)

$show=New-Object Windows.Forms.CheckBox
$show.Text='Mostrar token'
$show.Location='24,167'
$show.AutoSize=$true
$form.Controls.Add($show)
$show.Add_CheckedChanged({$token.UseSystemPasswordChar = -not $show.Checked})

$status=New-Object Windows.Forms.Label
$status.Location='24,198'
$status.Size='360,32'
$status.Text='O token sera salvo criptografado somente neste Windows.'
$form.Controls.Add($status)

$save=New-Object Windows.Forms.Button
$save.Text='TESTAR E SALVAR'
$save.Location='420,195'
$save.Size='154,38'
$form.Controls.Add($save)

$save.Add_Click({
  if([string]::IsNullOrWhiteSpace($token.Text)){
    [Windows.Forms.MessageBox]::Show('Cole o token do GitHub primeiro.') | Out-Null
    return
  }
  $save.Enabled=$false
  try{
    $headers=@{
      Authorization="Bearer $($token.Text.Trim())"
      Accept='application/vnd.github+json'
      'X-GitHub-Api-Version'='2022-11-28'
      'User-Agent'='RapTalisPublisher'
    }
    $me=Invoke-RestMethod 'https://api.github.com/user' -Headers $headers -TimeoutSec 20
    if(!$me.login){throw 'GitHub nao confirmou o usuario.'}
    SaveCfg $token.Text.Trim() $old
    [Windows.Forms.MessageBox]::Show("GitHub conectado como $($me.login). Token salvo com seguranca neste computador.",'Tudo certo') | Out-Null
    $form.Close()
  }catch{
    [Windows.Forms.MessageBox]::Show("Nao foi possivel validar o token.`n`n$($_.Exception.Message)",'Token invalido ou sem acesso') | Out-Null
  }finally{
    $save.Enabled=$true
  }
})

$form.Add_Shown({$token.Focus()})
[void]$form.ShowDialog()
