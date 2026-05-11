[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$OutputPath = ".\images\icon.png"
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$outputDirectory = Split-Path -Parent $OutputPath
if (-not [string]::IsNullOrWhiteSpace($outputDirectory) -and -not (Test-Path -LiteralPath $outputDirectory)) {
    New-Item -ItemType Directory -Path $outputDirectory | Out-Null
}

$bitmap = New-Object System.Drawing.Bitmap 128, 128, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.Clear([System.Drawing.Color]::Transparent)

function New-RectF([float]$x, [float]$y, [float]$w, [float]$h) {
    return New-Object System.Drawing.RectangleF $x, $y, $w, $h
}

function New-PointF([float]$x, [float]$y) {
    return New-Object System.Drawing.PointF $x, $y
}

function New-RoundedRectanglePath([float]$x, [float]$y, [float]$width, [float]$height, [float]$radius) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $diameter = $radius * 2
    $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
    $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
    $path.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

try {
    $backgroundPath = New-RoundedRectanglePath 0 0 128 128 24
    $backgroundBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-RectF 0 0 128 128),
        [System.Drawing.ColorTranslator]::FromHtml("#0078d4"),
        [System.Drawing.ColorTranslator]::FromHtml("#243a5e"),
        45
    )
    $graphics.FillPath($backgroundBrush, $backgroundPath)

    $cloudBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(36, 255, 255, 255))
    $graphics.FillEllipse($cloudBrush, (New-RectF 18 48 42 34))
    $graphics.FillEllipse($cloudBrush, (New-RectF 42 34 48 48))
    $graphics.FillEllipse($cloudBrush, (New-RectF 72 47 42 36))
    $graphics.FillRectangle($cloudBrush, 29, 63, 72, 21)

    $ringPenA = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml("#7ee6ff")), 8
    $ringPenA.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $ringPenA.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $ringPenB = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml("#35d07f")), 8
    $ringPenB.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $ringPenB.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $graphics.DrawArc($ringPenA, 28, 28, 72, 72, 205, 205)
    $graphics.DrawArc($ringPenB, 28, 28, 72, 72, 35, 205)

    $darkBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(222, 16, 36, 61))
    $graphics.FillEllipse($darkBrush, (New-RectF 34 34 60 60))

    $arrowBrushA = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml("#7ee6ff"))
    $graphics.FillPolygon($arrowBrushA, @(
        (New-PointF 31 40),
        (New-PointF 28 57),
        (New-PointF 16 47)
    ))
    $arrowBrushB = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml("#35d07f"))
    $graphics.FillPolygon($arrowBrushB, @(
        (New-PointF 97 88),
        (New-PointF 100 71),
        (New-PointF 112 81)
    ))

    $boltPoints = @(
        (New-PointF 59 25),
        (New-PointF 81 25),
        (New-PointF 67 55),
        (New-PointF 86 55),
        (New-PointF 53 103),
        (New-PointF 61 68),
        (New-PointF 43 68)
    )
    $boltBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml("#ffca28"))
    $boltPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(150, 255, 244, 179)), 3
    $boltPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $graphics.FillPolygon($boltBrush, $boltPoints)
    $graphics.DrawPolygon($boltPen, $boltPoints)

    $checkBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml("#0f6c3f"))
    $checkBorder = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml("#d7fff0")), 5
    $graphics.FillEllipse($checkBrush, (New-RectF 66 67 44 44))
    $graphics.DrawEllipse($checkBorder, (New-RectF 66 67 44 44))
    $checkPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 7
    $checkPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $checkPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $checkPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $graphics.DrawLines($checkPen, @(
        (New-PointF 78 89),
        (New-PointF 85 96),
        (New-PointF 99 80)
    ))

    $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host "Generated icon: $OutputPath"
}
finally {
    $graphics.Dispose()
    $bitmap.Dispose()
}
