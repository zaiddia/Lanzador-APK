# Revisión del equipo · configuración automática

> Desde 0.5.8 la configuración tiene «Iniciar revisión»: primero averigua si este equipo puede ejecutarlo y qué hay que cambiar;
> lo que se puede cambiar solo lo cambia, lo que requiere elevación tiene un botón y lo que solo se arregla en la BIOS se explica paso a paso.

## 1. Qué revisa

| Elemento | Cómo se revisa | Si no se puede leer |
|---|---|---|
| Virtualización de la CPU (VT-x / SVM) | `VirtualizationFirmwareEnabled` / `VMMonitorModeExtensions` de `Win32_Processor` | Se marca «desconocido» y se pide confirmarlo a mano |
| Si Hyper-V / VBS está activo | `Win32_ComputerSystem.HypervisorPresent` | Desconocido |
| Plataforma del hipervisor de Windows (WHPX) | `Get-WindowsOptionalFeature -FeatureName HypervisorPlatform`; sin permisos recurre a `WinHvPlatform.dll` + si existe el hipervisor | Desconocido (para darlo por «disponible» hacen falta las dos pruebas) |
| Si la aceleración por hardware funciona ahora | `emulator -accel-check` (reutiliza la conclusión en caché del provisioner) | Se toma como no disponible |
| Controlador AEHD | `%SystemRoot%\System32\drivers\aehd.sys` | Se toma como no instalado |
| GPU / memoria de video / versión del controlador | `Win32_VideoController` + registro `HardwareInformation.qwMemorySize` (`AdapterRAM` se trunca con >4 GB, no es fiable) | GPU desconocida |
| Memoria / versión del sistema | `Win32_ComputerSystem`, `os.release()` | — |

**La trampa de WMI**: cuando Hyper-V / la integridad de memoria (VBS) toman VT, `VMMonitorModeExtensions`
y `SecondLevelAddressTranslationExtensions` devuelven `False`, aunque el equipo sí puede usar aceleración por hardware.
Por eso, con esos campos en `False`, solo se concluye «sin virtualización» si «no hay hipervisor y la aceleración
tampoco funciona»; en cualquier otro caso se trata como desconocido. Si no, se descartaría por error un equipo que funciona bien.

## 2. Qué cambia solo

Tras la revisión, «Aplicar configuración recomendada» solo escribe estas opciones (todas seguras, se pueden revertir en la configuración cuando quieras):

| Opción | Regla |
|---|---|
| `memoryMB` | Equipo de 32 GB → 8 GB; 16 GB → 6 GB; 12 GB → 4 GB; 8 GB → 3 GB; menos → 2 GB. Nunca más de la mitad del anfitrión |
| `cores` | 8 hilos o más → 4 núcleos; 4~7 → 2~3 núcleos; siempre deja al menos 1 núcleo a Windows |
| `renderSize` | Sin aceleración por hardware o con memoria de video <512 MB → `540x960`; si no, `auto` |
| `gpuMode` | Con aceleración `auto` (lo decide la cadena de degradación); sin aceleración → `software` |
| `forceTcg` | Sin aceleración por hardware → `true` |

Además guarda los parámetros de este equipo como un controlador (`%APPDATA%\lanzadorapk\drivers\auto-<fabricante>-<build>.json`,
`priority: 5`), que se aplica solo en cada arranque, sin repetir la revisión.
Ese controlador también pasa por la validación de la lista permitida: lo que genera la revisión tampoco puede saltarse los límites de parámetros.

## 3. Lo que necesita al usuario

| Situación | Qué ofrece la interfaz |
|---|---|
| VT-x / SVM desactivado en la BIOS | **Solo una guía manual** (reiniciar y entrar a la BIOS → Intel VT-x / SVM Mode → Enabled). Este paso no se puede hacer por el usuario |
| Función de Windows desactivada (versión instalada) | «Activar con un clic (requiere administrador)» → ejecuta `dism` con elevación para activar HypervisorPlatform + VirtualMachinePlatform → pide reiniciar |
| Función de Windows desactivada (versión de la Store) | «Abrir la ventana Características de Windows»: MSIX tiene mediumIL fijo y no puede elevarse; solo da el acceso y qué marcar |
| Sin aceleración y con CPU compatible con virtualización (versión instalada) | Ofrece además «Instalar el controlador AEHD (requiere administrador)» |
| Controlador de GPU muy viejo (>3 años) | Solo recuerda actualizarlo desde la web del fabricante; no instala controladores solo (una versión equivocada es peor) |

## 4. Niveles de resultado

- `ok`: este punto está bien;
- `warn`: funciona, pero conviene mejorarlo (poca memoria, controlador viejo, sistema antiguo, información de hardware ilegible);
- `bad`: sin resolverlo no arranca (virtualización desactivada en la BIOS, función de Windows desactivada).

El nivel general de la revisión es el del peor punto; en la interfaz cada uno tiene un punto de color y una explicación concreta, nunca «error desconocido».

## 5. Privacidad

Toda la detección ocurre en el equipo: solo lee WMI / el registro / si existen archivos del sistema; no hace peticiones ni sube ninguna información.
El informe de diagnóstico exportado solo incluye los campos necesarios para diagnosticar, como modelo, versión del controlador y memoria.
