# adb portátil

Descomprime Android platform-tools en esta carpeta (debe quedar `adb.exe`) y LanzadorAPK lo usará primero:

```
tools/platform-tools/
└─ adb.exe
```

Descarga: https://developer.android.com/tools/releases/platform-tools

Si esta carpeta está vacía, LanzadorAPK prueba en este orden:

1. La ruta de adb indicada a mano en la configuración
2. Esta carpeta
3. `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`
4. El PATH del sistema

(El adb de emuladores de terceros ya no se usa: Lanzador APK solo funciona con su propio runtime).
