$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

function New-IconPng {
  param(
    [Parameter(Mandatory = $true)][int]$Size,
    [Parameter(Mandatory = $true)][string]$Path
  )

  $bmp = New-Object System.Drawing.Bitmap $Size, $Size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

  $bg = [System.Drawing.ColorTranslator]::FromHtml('#0b5fff')
  $g.Clear($bg)

  $fontSize = [Math]::Round($Size * 0.62)
  $font = New-Object System.Drawing.Font 'Segoe UI', $fontSize, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)

  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center

  $rect = New-Object System.Drawing.RectangleF 0, 0, $Size, $Size
  $g.DrawString('N', $font, $brush, $rect, $sf)

  $g.Dispose()
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

New-IconPng -Size 192 -Path (Join-Path $PSScriptRoot '..\\public\\icon-192.png')
New-IconPng -Size 512 -Path (Join-Path $PSScriptRoot '..\\public\\icon-512.png')

Write-Output 'Wrote public/icon-192.png and public/icon-512.png'

