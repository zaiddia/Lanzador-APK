'use strict';
/**
 * Diagnóstico del equipo + configuración automática.
 *
 * Por qué hace falta: que LanzadorAPK funcione tras instalarlo depende de cuatro cosas ajenas al programa:
 *   1. si la virtualización de la CPU (VT-x / AMD-V) está activada en la BIOS;
 *   2. si está activada la «Plataforma del hipervisor de Windows / Hyper-V» (WHPX depende de ella);
 *   3. hasta dónde llega la tarjeta gráfica (fabricante, memoria de video, versión del controlador, si puede usar renderizado por hardware);
 *   4. si la memoria / el disco alcanzan para una máquina virtual Android de 2–8 GB.
 *
 * Antes todo esto era «falla el arranque → el usuario mira el registro → adivina». Ahora se revisa primero; lo que se puede cambiar solo se cambia
 * (memoria, núcleos, calidad, motor de renderizado), lo que requiere permisos tiene un botón (activar la función / instalar el controlador),
 * y lo que solo se hace en la BIOS se explica claramente: qué tecla pulsar y qué cambiar.
 *
 * Capas:
 *   - collect()   solo detecta (en Windows con una sola llamada de PowerShell para toda la información), con rutas de respaldo;
 *   - evaluate()  función pura: convierte la detección en «elementos del diagnóstico + configuración sugerida», probable;
 *   - las acciones están en main.js (guardar la configuración / llamar a las interfaces de elevación existentes); este módulo no toca permisos.
 *
 * Ojo: **no se finge poder activar la virtualización de la BIOS por el usuario**. Ese paso solo lo puede hacer una persona; aquí solo se evalúa y se indica el camino.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

// ---------------- Detección ----------------

/**
 * Ejecuta un script rápido (powershell.exe de Windows) y obtiene JSON; si falla/se agota devuelve null.
 *
 * Se usa execFile asíncrono y no execFileSync: iniciar el script + dos consultas CIM tarda 1–2 s,
 * y en modo síncrono bloquearía el proceso principal (es decir, toda la interfaz); el usuario creería que «Iniciar diagnóstico» colgó el programa.
 */
function psJson(script, timeout = 15000) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const { execFile } = require('child_process');
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
      ], { encoding: 'utf8', windowsHide: true, timeout }, (err, stdout) => {
        if (err) { resolve(null); return; }
        const t = String(stdout || '').trim();
        if (!t) { resolve(null); return; }
        try { resolve(JSON.parse(t)); } catch (_) { resolve(null); }
      });
    } catch (_) {
      resolve(null);
    }
  });
}

const HW_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue";',
  '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors,VirtualizationFirmwareEnabled,VMMonitorModeExtensions,SecondLevelAddressTranslationExtensions;',
  '$cs = Get-CimInstance Win32_ComputerSystem | Select-Object -First 1 HypervisorPresent,TotalPhysicalMemory;',
  '$gpu = @(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,DriverDate,AdapterRAM,VideoProcessor,Status);',
  // AdapterRAM se trunca en 4294967295 cuando supera 4 GB; el valor real está en el registro, qwMemorySize (una subclave 000N por adaptador)
  '$vram = 0;',
  'Get-ChildItem "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}" -ErrorAction SilentlyContinue | ForEach-Object {',
  '  $v = (Get-ItemProperty $_.PSPath -Name "HardwareInformation.qwMemorySize" -ErrorAction SilentlyContinue)."HardwareInformation.qwMemorySize";',
  '  if ($v -and $v -gt $vram) { $vram = $v }',
  '};',
  '[pscustomobject]@{ cpu = $cpu; cs = $cs; gpu = $gpu; vram = $vram } | ConvertTo-Json -Depth 6 -Compress',
].join(' ');

const FEATURE_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue";',
  '$o = [ordered]@{};',
  'foreach ($n in @("HypervisorPlatform","VirtualMachinePlatform","Microsoft-Hyper-V-All")) {',
  '  try { $o[$n] = (Get-WindowsOptionalFeature -Online -FeatureName $n -ErrorAction Stop).State } catch { $o[$n] = "unknown" }',
  '}',
  '$o | ConvertTo-Json -Compress',
].join(' ');

/** Comprueba si existe un archivo (detecta la librería de API de WHPX / el controlador AEHD / el servicio de plataforma de máquina virtual) */
function fileExists(rel) {
  try {
    return fs.existsSync(path.join(process.env.SystemRoot || 'C:\\Windows', rel));
  } catch (_) {
    return false;
  }
}

function dateToISO(v) {
  if (!v) return '';
  // DateTime de PowerShell → `/Date(1700000000000)/` o cadena ISO
  const m = /\/Date\((\d+)\)\//.exec(String(v));
  if (m) {
    try { return new Date(Number(m[1])).toISOString().slice(0, 10); } catch (_) { return ''; }
  }
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

/**
 * Detecta el hardware y el estado de virtualización del equipo.
 *
 * Si algo no se puede obtener devuelve null/0; **un fallo de detección nunca debe tumbar a quien llama**:
 * Lo que no se encuentra es «desconocido», y en el diagnóstico aparece «no se pudo leer», en vez de inventar una conclusión.
 *
 * @param {object} o { accel } accel viene de provisioner.emulatorAccel(), para no lanzar emulator otra vez
 * @returns {object} hw
 */
async function collect({ accel = null } = {}) {
  const [raw, feats] = process.platform === 'win32'
    ? await Promise.all([psJson(HW_SCRIPT), psJson(FEATURE_SCRIPT)])
    : [null, null];
  const cpu = (raw && raw.cpu) || {};
  const cs = (raw && raw.cs) || {};
  const gpus = Array.isArray(raw && raw.gpu) ? raw.gpu : (raw && raw.gpu ? [raw.gpu] : []);

  // Elige la «GPU principal»: primero las que no son Microsoft Basic Display / adaptadores de pantalla virtuales
  const usable = gpus.filter((g) => g && g.Name && !/microsoft basic|remote display|virtual display/i.test(g.Name));
  const gpu = (usable[0] || gpus[0]) || {};
  const name = String(gpu.Name || '');
  let vendor = 'unknown';
  if (/nvidia|geforce|rtx\s|gtx\s|quadro/i.test(name)) vendor = 'nvidia';
  else if (/(?<!virtual\s)(amd|radeon|rx\s\d)/i.test(name)) vendor = 'amd';
  else if (/intel|uhd\s|iris|arc\s/i.test(name)) vendor = 'intel';

  const ramBytes = Number(gpu.AdapterRAM) || 0;
  const qw = Number((raw && raw.vram) || 0);
  // AdapterRAM es un entero de 32 bits sin signo; con >4 GB queda en 4095 MB y ese valor no es fiable
  const vramMB = Math.round((qw > 0 ? qw : (ramBytes > 0 && ramBytes < 4096 * 1024 * 1024 ? ramBytes : 0)) / 1048576);

  const hypervisor = cs.HypervisorPresent === true;
  const accelOk = !!(accel && accel.ok);
  /**
   * Ojo con estos dos campos de WMI (probado en un equipo real):
   * cuando Hyper-V / VBS toman el control de VT, `VMMonitorModeExtensions` y
   * `SecondLevelAddressTranslationExtensions` devuelven False, aunque el equipo sí puede usar aceleración por hardware.
   * Por eso «False» solo cuenta como «no compatible» cuando «no hay hipervisor y la aceleración tampoco funciona»;
   * en cualquier otro caso es «desconocido», para no tomar por incompatible un equipo que sí sirve.
   */
  const vmExt = cpu.VMMonitorModeExtensions;
  const slatRaw = cpu.SecondLevelAddressTranslationExtensions;
  let vtSupported = true;
  if (vmExt === false && !hypervisor && !accelOk) vtSupported = false;
  else if (vmExt !== true) vtSupported = 'unknown';
  const slat = slatRaw === true ? true : (slatRaw === false && !hypervisor && !accelOk ? false : 'unknown');
  // Lado BIOS: igual; con el hipervisor en marcha los campos de firmware tampoco son fiables
  let vtFirmware = null;
  if (cpu.VirtualizationFirmwareEnabled === true) vtFirmware = true;
  else if (cpu.VirtualizationFirmwareEnabled === false && !hypervisor && !accelOk) vtFirmware = false;
  const winHv = fileExists('System32\\WinHvPlatform.dll');
  const vmCompute = fileExists('System32\\vmcompute.exe');
  const aehd = fileExists('System32\\drivers\\aehd.sys');

  const state = (k) => {
    const v = feats && feats[k];
    return v ? String(v).toLowerCase() : 'unknown';
  };

  return {
    platform: process.platform,
    arch: process.arch,
    osBuild: (() => {
      const m = /(\d+)\s*$/.exec(os.release() || '');
      return m ? Number(m[1]) : 0;
    })(),
    cpu: {
      name: String(cpu.Name || '').trim(),
      cores: Number(cpu.NumberOfCores) || 0,
      threads: Number(cpu.NumberOfLogicalProcessors) || 0,
      vtSupported,
      vtFirmware,
      slat,
    },
    memory: {
      totalMB: Math.round((Number(cs.TotalPhysicalMemory) || os.totalmem()) / 1048576),
      freeMB: Math.round(os.freemem() / 1048576),
    },
    gpu: {
      name,
      vendor,
      vramMB,
      driverVersion: String(gpu.DriverVersion || ''),
      driverDate: dateToISO(gpu.DriverDate),
      status: String(gpu.Status || ''),
    },
    virtualization: {
      hypervisorPresent: hypervisor,
      hypervisorPlatform: state('HypervisorPlatform'),
      vmPlatform: state('VirtualMachinePlatform'),
      hyperV: state('Microsoft-Hyper-V-All'),
      winHvApi: winHv,
      vmCompute,
      aehdInstalled: aehd,
      accelOk,
      accelKind: accel && accel.ok ? String(accel.kind || 'whpx') : 'none',
    },
  };
}

// ---------------- Evaluación (funciones puras) ----------------

/** Niveles recomendados de hardware: memoria / núcleos / calidad. Reglas conservadoras: mejor dar de menos que de más. */
function recommendResources({ totalMB = 0, cores = 0, accelOk = false, vramMB = 0 } = {}) {
  const mem = Number(totalMB) || 0;
  const n = Number(cores) || 1;
  // La máquina virtual usa como máximo la mitad del anfitrión y deja 1 núcleo para Windows; luego se ajusta otra vez a un rango absoluto
  let memoryMB = 2048;
  if (mem >= 32768) memoryMB = 8192;
  else if (mem >= 16384) memoryMB = 6144;
  else if (mem >= 12288) memoryMB = 4096;
  else if (mem >= 8192) memoryMB = 3072;
  else memoryMB = 2048;
  if (mem && memoryMB > Math.floor(mem * 0.5 / 512) * 512) {
    memoryMB = Math.max(2048, Math.floor(mem * 0.5 / 512) * 512);
  }
  const wantCores = n >= 8 ? 4 : n >= 4 ? Math.max(2, n - 2) : 2;
  const c = Math.max(1, Math.min(wantCores, n - 1));
  // Emulación por software + poca memoria de video: la resolución baja a 540p, priorizando los fotogramas (es solo el 56 % del área)
  const renderSize = (!accelOk || (vramMB > 0 && vramMB < 512)) ? '540x960' : 'auto';
  return { memoryMB, cores: c, renderSize };
}

/** Sugerencia de motor de renderizado: según fabricante + aceleración + memoria de video da un nivel «para probar primero» */
function recommendGpu({ vendor = 'unknown', accelOk = false, vramMB = 0 } = {}) {
  if (!accelOk) return { gpuMode: 'software', why: 'No hay aceleración por hardware disponible; se usa renderizado por software para asegurar que haya imagen' };
  if (vendor === 'unknown') return { gpuMode: 'auto', why: 'No se pudo leer el modelo de la tarjeta gráfica; se deja que la cadena de respaldo automática lo pruebe' };
  if (!vramMB || vramMB < 512) return { gpuMode: 'swangle', why: 'Poca memoria de video (o no se puede leer); swangle es más estable' };
  if (vendor === 'nvidia') return { gpuMode: 'host', why: 'Los controladores de NVIDIA son maduros; host suele ser lo más rápido' };
  if (vendor === 'amd') return { gpuMode: 'swangle', why: 'En gráficos integrados AMD o con controladores antiguos host puede fallar tras arrancar; swangle es más estable' };
  if (vendor === 'intel') return { gpuMode: 'swangle', why: 'El soporte GLES de los gráficos integrados Intel es irregular; swangle es más estable' };
  return { gpuMode: 'auto', why: 'No se pudo leer el modelo de la tarjeta gráfica; se deja que la cadena de respaldo automática lo pruebe' };
}

/**
 * Convierte el resultado de la detección en un informe de diagnóstico.
 *
 * @param {object} o { hw, settings, edition } edition: 'store' | 'installer'
 * @returns {{ level:string, items:Array, patch:object|null, driver:object|null, summary:string }}
 */
function evaluate({ hw = {}, settings = {}, edition = 'installer' } = {}) {
  const v = hw.virtualization || {};
  const cpu = hw.cpu || {};
  const gpu = hw.gpu || {};
  const mem = hw.memory || {};
  const items = [];

  const add = (item) => items.push(item);

  // ---- 1. Virtualización de la CPU (BIOS) ----
  if (cpu.vtSupported === false) {
    add({
      key: 'vt-unsupported',
      level: 'bad',
      title: 'Esta CPU no admite virtualización por hardware',
      detail: 'Solo funciona la emulación por software, entre 5 y 10 veces más lenta. Sirve para apps ligeras; no se recomienda para juegos grandes.',
      action: null,
    });
  } else if (cpu.vtFirmware === false) {
    add({
      key: 'vt-bios-off',
      level: 'bad',
      title: 'La virtualización de la CPU no está activada en la BIOS',
      detail: 'Reinicia y entra a la BIOS/UEFI, pon Intel VT-x (Intel) o SVM Mode (AMD) en Enabled, guarda y vuelve a hacer el diagnóstico. '
        + 'En Lenovo/Dell/ASUS suele estar en Advanced → CPU Configuration; en equipos de marca puede llamarse Virtualization Technology.',
      action: { kind: 'manual', id: 'bios', label: 'Hay que reiniciar y entrar a la BIOS; no se puede hacer automáticamente' },
    });
  } else if (cpu.vtFirmware === true) {
    add({
      key: 'vt-ok',
      level: 'ok',
      title: 'La virtualización de la CPU está activada en la BIOS',
      detail: cpu.name ? `${cpu.name} · ${cpu.cores || '?'} núcleos / ${cpu.threads || '?'} hilos` : '',
      action: null,
    });
  } else {
    add({
      key: 'vt-unknown',
      level: 'warn',
      title: 'No se pudo leer el estado de la virtualización de la CPU',
      detail: 'Puede ser una limitación de la placa base o de permisos. Si al arrancar dice que no hay aceleración por hardware, entra a la BIOS y confirma que VT-x / SVM estén activados.',
      action: { kind: 'manual', id: 'bios', label: 'Confirmar manualmente' },
    });
  }

  // ---- 2. Lado de Windows: WHPX / Hyper-V ----
  const hp = String(v.hypervisorPlatform || 'unknown');
  const hpxOn = hp === 'enabled' || (hp === 'unknown' && v.winHvApi && v.hypervisorPresent);
  if (hpxOn) {
    add({
      key: 'whpx-ok',
      level: 'ok',
      title: 'Plataforma del hipervisor de Windows activada',
      detail: v.hypervisorPresent
        ? 'El hipervisor está en marcha; WHPX está disponible.'
        : 'La función está activada; si la aceleración sigue sin funcionar, reinicia una vez para que arranque el hipervisor.',
      action: null,
    });
  } else if (edition === 'store') {
    add({
      key: 'whpx-off',
      level: 'bad',
      title: '«Plataforma del hipervisor de Windows» no está activada',
      detail: 'La versión de la Store no puede cambiar funciones del sistema. Pulsa Win+R → escribe optionalfeatures → marca «Plataforma del hipervisor de Windows» '
        + '(HypervisorPlatform) y «Plataforma de máquina virtual» → Aceptar → reinicia.',
      action: { kind: 'elevate', id: 'virtualization', label: 'Abrir la ventana «Características de Windows»' },
    });
  } else {
    add({
      key: 'whpx-off',
      level: 'bad',
      title: '«Plataforma del hipervisor de Windows» no está activada',
      detail: 'El botón de abajo activa automáticamente HypervisorPlatform + VirtualMachinePlatform (requiere confirmación de administrador); al terminar, reinicia el equipo.',
      action: { kind: 'elevate', id: 'virtualization', label: 'Activar con un clic (requiere administrador)' },
    });
  }

  // ---- 3. Si la aceleración por hardware funciona de verdad ahora ----
  if (v.accelOk) {
    add({
      key: 'accel-ok',
      level: 'ok',
      title: `Aceleración por hardware disponible (${v.accelKind === 'aehd' ? 'AEHD' : 'WHPX'})`,
      detail: 'Se arrancará con aceleración por hardware; la configuración de abajo se recomienda según la tarjeta gráfica y la memoria de este equipo.',
      action: null,
    });
  } else {
    add({
      key: 'accel-off',
      level: 'warn',
      title: 'Ahora mismo no hay aceleración por hardware',
      detail: edition === 'installer' && v.vtFirmware !== false
        ? 'Puedes instalar el controlador AEHD (requiere administrador) o activar «Plataforma del hipervisor de Windows» y reiniciar; si nada funciona, solo queda la emulación por software.'
        : 'Se usará primero emulación por software para que funcione; es entre 5 y 10 veces más lenta que con aceleración.',
      action: edition === 'installer' && v.vtFirmware !== false
        ? { kind: 'elevate', id: 'accel', label: 'Instalar controlador AEHD (requiere administrador)' }
        : null,
    });
  }

  // ---- 4. Tarjeta gráfica ----
  if (!gpu.name) {
    add({
      key: 'gpu-unknown',
      level: 'warn',
      title: 'No se pudo leer la información de la tarjeta gráfica',
      detail: 'Puede deberse a escritorio remoto, una máquina virtual o un problema del controlador. El motor de renderizado queda a cargo de la cadena de respaldo automática.',
      action: null,
    });
  } else {
    const integrated = /radeon\s+(graphics|vega)|uhd|iris|hd\s+graphics|vega/i.test(gpu.name);
    const vram = gpu.vramMB
      ? `${(gpu.vramMB / 1024).toFixed(1)} GB de memoria de video ${integrated ? ' (gráficos integrados; el resto usa memoria compartida)' : ''}`
      : 'Memoria de video desconocida';
    add({
      key: 'gpu-info',
      level: 'ok',
      title: `${gpu.name}`,
      detail: `${vram}${gpu.driverVersion ? ` · controlador ${gpu.driverVersion}` : ''}${gpu.driverDate ? ` (${gpu.driverDate})` : ''}`,
      action: null,
    });
    const old = /^(19|20)\d{2}-\d{2}-\d{2}$/.test(gpu.driverDate || '')
      ? (Date.now() - new Date(gpu.driverDate).getTime()) / 31536000000 : 0;
    if (old > 3) {
      add({
        key: 'gpu-driver-old',
        level: 'warn',
        title: 'El controlador de la tarjeta gráfica es antiguo',
        detail: `Fecha del controlador ${gpu.driverDate} (hace unos ${Math.floor(old)} años). Los controladores viejos suelen causar «pantalla negra o con artefactos tras arrancar»; actualízalo desde la web del fabricante.`,
        action: null,
      });
    }
  }

  // ---- 5. Memoria / disco / versión del sistema ----
  const total = Number(mem.totalMB) || 0;
  if (!total) {
    add({ key: 'mem-unknown', level: 'warn', title: 'No se pudo leer la memoria física', detail: '', action: null });
  } else if (total < 6144) {
    add({
      key: 'mem-low',
      level: 'warn',
      title: `Poca memoria (${(total / 1024).toFixed(1)} GB)`,
      detail: 'La máquina virtual Android solo puede tener 2 GB y 2 núcleos, la calidad baja a 540×960 y conviene cerrar pestañas del navegador antes de abrir apps.',
      action: null,
    });
  } else {
    add({
      key: 'mem-ok',
      level: 'ok',
      title: `Memoria física ${(total / 1024).toFixed(0)} GB`,
      detail: '',
      action: null,
    });
  }

  const build = Number(hw.osBuild) || 0;
  if (build && build < 19041) {
    add({
      key: 'os-old',
      level: 'warn',
      title: `Versión de Windows antigua (build ${build})`,
      detail: 'Lanzador APK requiere al menos Windows 10 2004 (build 19041). En sistemas más antiguos el emulador puede cerrarse directamente.',
      action: null,
    });
  }

  // ---- Configuración sugerida ----
  const rec = recommendResources({ totalMB: total, cores: cpu.threads || cpu.cores, accelOk: !!v.accelOk, vramMB: gpu.vramMB });
  const gpuRec = recommendGpu({ vendor: gpu.vendor, accelOk: !!v.accelOk, vramMB: gpu.vramMB });
  const patch = {
    engine: {
      autoMemory: false,
      memoryMB: rec.memoryMB,
      cores: rec.cores,
      renderSize: rec.renderSize,
      // Aceleración no disponible → se fija directamente la emulación por software, ahorrando dos rondas inútiles; si está disponible se vuelve a auto para que funcione la cadena de degradación
      gpuMode: v.accelOk ? 'auto' : 'software',
      forceTcg: !v.accelOk,
    },
  };

  // Genera un controlador para este equipo: cada arranque lo sigue, sin repetir el diagnóstico
  const vendor = gpu.vendor && gpu.vendor !== 'unknown' ? gpu.vendor : 'unknown';
  const driver = {
    format: 'lanzadorapk-driver/1',
    id: `auto-${vendor}-${build || 'x'}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-'),
    name: `Configuración automática para este equipo (${gpu.name || vendor})`,
    version: '1.0.0',
    author: 'Diagnóstico de Lanzador APK',
    description: `Generado por «Diagnóstico del equipo · configuración automática»: ${gpuRec.why}. ${v.accelOk ? 'Aceleración por hardware disponible.' : 'Ahora mismo no hay aceleración por hardware.'}`,
    priority: 5,
    match: {
      platform: [hw.platform || process.platform],
      arch: [hw.arch || process.arch],
      ...(vendor !== 'unknown' ? { gpuVendor: [vendor] } : {}),
      ...(build ? { osBuild: { min: build - 2000, max: build + 2000 } } : {}),
    },
    effect: {
      gpuMode: gpuRec.gpuMode,
      ...(v.accelOk ? {} : { forceTcg: true }),
      notes: [gpuRec.why],
    },
  };

  const bad = items.filter((i) => i.level === 'bad').length;
  const warn = items.filter((i) => i.level === 'warn').length;
  const level = bad ? 'bad' : warn ? 'warn' : 'good';
  const summary = bad
    ? `Se encontraron ${bad} elementos que hay que resolver primero (${items.filter((i) => i.level === 'bad').map((i) => i.title).join(',')})`
    : warn
      ? `Hay ${warn} elementos recomendados (${items.filter((i) => i.level === 'warn').map((i) => i.title).join(',')})`
      : 'Este equipo puede usar aceleración por hardware directamente; la configuración ya es la óptima';

  return {
    level,
    items,
    patch,
    driver,
    recommended: { ...rec, ...gpuRec },
    summary,
  };
}

module.exports = {
  collect,
  evaluate,
  recommendResources,
  recommendGpu,
  psJson,
};
