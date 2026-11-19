# Carpeta del motor del runtime (colocación manual, opcional)

**Desde 0.2, LanzadorAPK se basta solo por defecto**: la app descarga e instala adb, QEMU y las imágenes del sistema en
`%APPDATA%\lanzadorapk\runtime\`, sin que haya que preparar nada a mano.

Esta carpeta solo se usa en estos dos casos:

## 1. Colocar QEMU a mano (fuente de descarga bloqueada / para usar una versión concreta)

```
engine/qemu/
├─ qemu-system-x86_64.exe
├─ qemu-img.exe
└─ … (el resto de archivos de QEMU)
```

Compilaciones oficiales de QEMU para Windows: https://qemu.weilnetz.de/w64/
(`qemu-w64-setup-*.exe` es un instalador NSIS; LanzadorAPK lo instala en silencio en la carpeta del runtime con `/S /D=`;
también puedes descomprimir el instalador con 7-Zip y ponerlo en la ubicación de arriba)

## 2. Colocar adb a mano

```
tools/platform-tools/
└─ adb.exe
```

Descarga: https://developer.android.com/tools/releases/platform-tools

## Imágenes del sistema

- Recomendada: Android-x86 9.0-r2 (x86_64), descargable desde la app (varias imágenes, con reanudación)
- O importar: cualquier imagen de disco con Android ya instalado (qcow2 / raw / vmdk), desde «Runtime → Importar»
- Tras importarla, LanzadorAPK arranca directamente desde el disco, sin paso de instalación

## Aceleración por hardware

QEMU acelera con WHPX: Panel de control → «Activar o desactivar las características de Windows» → marca «Plataforma de máquina virtual» → reinicia.
Si no está activada, LanzadorAPK pasa solo a emulación por software (TCG) y el primer inicio es más lento.
