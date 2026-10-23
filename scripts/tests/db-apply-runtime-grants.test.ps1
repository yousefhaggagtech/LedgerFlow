# No Docker/Pester dependency: exercise input parsing and SQL encoding directly.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$path = Join-Path $PSScriptRoot '../db-apply-runtime-grants.ps1'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Provisioning script has syntax errors.' }
foreach ($name in @('Read-DotEnv', 'Sql-Text')) {
    $definition = $ast.Find({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    # Load only trusted function definitions; never execute provisioning or .env data.
    . ([scriptblock]::Create($definition.Extent.Text))
}

$script:lines = @(
    '# comment', '', 'export POSTGRES_USER=ledgerflow',
    'RUNTIME_DB_USER="quoted user" # comment',
    "RUNTIME_DB_PASSWORD='a\b`$()''; \connect evil'",
    'DATABASE_URL=postgresql://local/db # comment', 'EMPTY='
)
function Get-Content { param($LiteralPath, $Encoding) return $script:lines }
$values = Read-DotEnv 'unused'
if ($values.POSTGRES_USER -ne 'ledgerflow' -or $values.RUNTIME_DB_USER -ne 'quoted user' -or
    $values.DATABASE_URL -ne 'postgresql://local/db' -or $values.EMPTY -ne '') {
    throw 'Literal .env parsing regression.'
}
$payload = $values.RUNTIME_DB_PASSWORD
$encoded = Sql-Text $payload
if ($encoded -notmatch "^convert_from\(decode\('([0-9A-F]*)', 'hex'\), 'UTF8'\)$") {
    throw 'Unsafe SQL encoding.'
}
$hex = $Matches[1]
$bytes = for ($i = 0; $i -lt $hex.Length; $i += 2) { [Convert]::ToByte($hex.Substring($i, 2), 16) }
if ([Text.Encoding]::UTF8.GetString([byte[]]$bytes) -cne $payload) { throw 'Password encoding changed its value.' }
foreach ($line in @('NOT AN ASSIGNMENT', 'PASSWORD="unterminated')) {
    $script:lines = @($line)
    $rejected = $false
    try { $null = Read-DotEnv 'unused' } catch { $rejected = $true }
    if (-not $rejected) { throw 'Malformed .env input was accepted.' }
}
Write-Output 'PASS: literal env parsing, quoted passwords, SQL metacharacter roundtrip, malformed-input rejection.'
