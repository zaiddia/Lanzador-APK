# Base FydeOS de LanzadorAPK (también en Windows) — histórico: las bases de terceros se eliminaron en 0.5.6

> En una frase: **usar el entorno Android que trae FydeOS en lugar del emulador de Google**.
> FydeOS puede instalarse en el equipo o correr dentro de VMware / VirtualBox, con LanzadorAPK conectándose desde Windows.

---

## ⚠️ Lee esto primero: los riesgos reales de la ruta FydeOS

Investigué a fondo la viabilidad de esta ruta y la conclusión no es optimista; **conviene saberlo antes de decidir si invertir en ella**:

1. **La imagen oficial para VMware es preview**. La página de descarga dice que está «diseñada para que los usuarios
   **prueben y previsualicen** FydeOS en entornos virtualizados» ([FydeOS for VMware](https://fydeos.com/download/vm/x86_64/)).
2. **En la versión VMware el subsistema Android a menudo no funciona**. La comunidad de FydeOS dice claramente que
   «la versión VMware es solo una vista previa y por ahora no garantiza que todas las funciones estén disponibles»; hay usuarios que reportan
   apps Android sin red y `adb` que conecta pero con pantalla negra.
   ([discusión de la comunidad](https://community.fydeos.com/t/topic/47865))
3. **Hay quien dice que una versión vieja (v18) sí funciona** y que las nuevas se rompieron. O sea, esta ruta depende de una versión concreta
   y podría dejar de funcionar cualquier día.

**Conclusión**: hice la base FydeOS y funciona, pero **no debería tomarse como la opción principal**.
Si solo quieres algo «más ligero que el emulador de Google y sin problemas de ventanas»,
la red arreglada + el **modo de ventana independiente** de v0.5.0 ya lo resuelven, sin cambiar de base.

---

## Dos formas de uso

### Forma A: LanzadorAPK y FydeOS en el mismo equipo (FydeOS instalado en el equipo)

Requisito: lo que tienes instalado es el propio sistema FydeOS (no Windows).

1. Lanzador de apps de FydeOS → abre «Ajustes de Android»
2. Sistema → Opciones para desarrolladores → activa **Depuración ADB**
   (si no ves las opciones para desarrolladores: Ajustes de Android → Acerca del dispositivo → pulsa 7 veces «Número de compilación»)
3. Ajustes de FydeOS → Linux → activa el subsistema Linux
4. En la terminal Linux: `sudo apt update && sudo apt install -y adb`
5. LanzadorAPK → Configuración → Runtime → modo de motor **Subsistema Android de FydeOS**, dirección **vacía**
   (prueba en orden `arc:5555`, `100.115.92.2:5555`, `127.0.0.1:5555`)

### Forma B: LanzadorAPK en Windows y FydeOS en una máquina virtual

Esta es la forma que buscabas. Pasos completos:

#### 1. Instala un programa de máquinas virtuales

- **VMware Workstation Player** (gratis): la imagen oficial de FydeOS para VM es un `.ova`; basta con importarla
- **VirtualBox**: también sirve, pero tras importar el `.ova` puede que haya que ajustar UEFI a mano

> Ojo: **no uses Hyper-V**. El runtime propio de LanzadorAPK acelera con AEHD, y AEHD y Hyper-V son incompatibles;
> con Hyper-V activado el runtime propio deja de funcionar. Con VMware / VirtualBox no pasa.

#### 2. Importa la imagen de FydeOS

Descarga el `.ova` de la [página de descarga de FydeOS for VMware](https://fydeos.com/download/vm/x86_64/)
(1,5 GB o más) y en VMware «Abrir una máquina virtual» → elige ese `.ova`.
Si dice «no pasó la comprobación de conformidad de la especificación OVF», pulsa **Reintentar** para relajar la validación y se importa igual.

Conviene dar a la máquina virtual **4 GB de memoria o más** (el subsistema Android consume mucha).

#### 3. Activa la depuración ADB en FydeOS

1. Arranca la máquina virtual y completa la configuración inicial de FydeOS (inicio de sesión/cuenta local)
2. Abre los ajustes de Android y activa el subsistema Android
3. Ajustes de Android → Sistema → Opciones para desarrolladores → activa **Depuración ADB**

#### 4. Haz que Windows pueda conectarse a esa máquina virtual

Dos opciones; elige una:

**Opción 1 (recomendada, la más sencilla): reenvío de puertos NAT**

VMware: Configuración de la máquina virtual → Adaptador de red → NAT → «Configuración NAT» → Reenvío de puertos → Agregar:

| Puerto del anfitrión | Tipo | IP de la máquina virtual | Puerto de la máquina virtual |
|---|---|---|---|
| 5555 | TCP | (vacío o 192.168.x.x) | 5555 |

VirtualBox: Configuración → Red → Avanzado → Reenvío de puertos → agrega `127.0.0.1:5555 → 10.0.2.15:5555`

Luego en LanzadorAPK pon como dirección: `127.0.0.1:5555`

**Opción 2: usar directamente la IP de la máquina virtual**

Pon la red de la máquina virtual en «Puente»; en FydeOS abre `crosh` (Ctrl+Alt+T) → `shell` → `ip addr` para ver la IP,
y en LanzadorAPK pon `<esa IP>:5555`.

#### 5. Configura LanzadorAPK

1. Configuración → Runtime → modo de motor **Subsistema Android de FydeOS**
2. Pon la dirección del paso anterior (por ejemplo `127.0.0.1:5555`)
3. Pulsa Detectar

**En la primera conexión FydeOS muestra el diálogo «¿Permitir la depuración?»: pulsa «Permitir» sí o sí**;
si no, no se podrán instalar los APK.

---

## Diferencias con el runtime propio

| | Runtime propio (QEMU) | Base FydeOS |
|---|---|---|
| De dónde sale Android | LanzadorAPK descarga la imagen y arranca él mismo | Lo da el sistema FydeOS, ya en marcha |
| Inicio tras apagar | Hay que arrancar (unos 18 s en v0.5.0) | Casi instantáneo (la máquina virtual ya está encendida) |
| Memoria extra | Unos 3 GB | Depende de lo asignado a la máquina virtual |
| Espacio de imágenes | Varios GB | Ninguno (el disco propio de FydeOS) |
| Incrustación de ventanas | ✅ se incrusta en la ventana de LanzadorAPK | ❌ la imagen la muestra FydeOS |
| Una ventana por app | ✅ | ❌ todas las apps comparten el escritorio de FydeOS |
| Estabilidad | Alta (probado) | **Depende de la versión de FydeOS; ver el aviso del principio** |

**Sobre «una ventana por app»**: es la parte más valiosa de la experiencia de LanzadorAPK y la base FydeOS no la ofrece.
El motivo es que la imagen de Android está en el escritorio de FydeOS (o en la ventana de esa máquina virtual), no en una ventana
propia de cada app Android, y no hay un HWND al que hacer `SetParent`.

Por eso, con la base FydeOS, el papel de LanzadorAPK pasa a ser: **lista de apps + instalación + inicio + gestión de iconos/accesos directos**,
y la imagen la muestra FydeOS.

---

## Preguntas frecuentes

### Aviso «primero indica la dirección de FydeOS»

En Windows no hay «Android del equipo» y LanzadorAPK no puede adivinar dónde está la máquina virtual. Configura el reenvío de puertos del paso 4 o pon la IP.

### Siempre unauthorized y el diálogo de autorización no aparece

Problema conocido de algunas versiones de FydeOS X (la clave adb del anfitrión y la del subsistema Linux no coinciden). Sincroniza la clave a mano:

```bash
# 1. En la terminal Linux de FydeOS
adb start-server
cat ~/.android/adbkey.pub      # copia el contenido

# 2. Crosh (Ctrl+Alt+T) → shell para entrar al anfitrión
sudo mount -o remount,rw /
sudo mkdir -p /opt/google/containers/android/rootfs/android-data/data/misc/adb
sudo tee /opt/google/containers/android/rootfs/android-data/data/misc/adb/adb_keys <<'EOF'
<pega aquí el contenido de adbkey.pub de arriba>
EOF
sudo chown 1000:1000 /opt/google/containers/android/rootfs/android-data/data/misc/adb/adb_keys
sudo mount -o remount,ro /
```

Luego reinicia el subsistema Android y vuelve a conectar.

### Conecta pero la app instalada no abre

Si es `INSTALL_FAILED_NO_MATCHING_ABIS`, el APK solo tiene versión arm64 y FydeOS
corre en x86. FydeOS trae una capa de compatibilidad ARM, pero no lo cubre todo: con estas apps es más fácil que funcione el runtime propio
(que trae la traducción ARM de Google).

### Pantalla negra en la app

Es el problema viejo de la versión VMware de FydeOS (ver el aviso del principio). Primero confirma si las apps Android que trae FydeOS abren bien;
si las propias apps del sistema también quedan en negro, el problema no es de LanzadorAPK: cambia de versión de FydeOS (hay quien dice que v18 funciona) o usa el runtime propio.

---

## Detalles técnicos (para mantenedores)

- El backend está en `src/core/backends/fydeos.js`
- Los bits de capacidad se declaran con mucha prudencia: sin `provision` (no instala imágenes), sin `snapshot` (no tiene instantáneas propias),
  sin `rotatePanel` (la pantalla la gestiona el sistema). Solo `shutdown`, y únicamente desconecta adb:
  no apaga de verdad el Android del sistema, porque eso afectaría a las demás apps del usuario.
- `embedCapable = false`. La capa superior (`attachAppWindow` en `main.js`) ve esta marca y se salta
  la toma de la imagen, en vez de intentar un `SetParent` que falla y llenar el registro de `attach failed`.
- En Windows se usa el adb que trae LanzadorAPK (`runtime/platform-tools/adb.exe`);
  no hace falta que el usuario instale platform-tools.
