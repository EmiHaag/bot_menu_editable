# WhatsApp Menu Bot (Scalable Architecture)

Este es un bot de WhatsApp modular y escalable que utiliza Google Sheets como fuente de verdad para su sistema de menús jerárquicos.

## Estructura de Google Sheets

La hoja de cálculo de Google debe tener una hoja llamada `Menu` con las siguientes columnas en la primera fila:

| ID | ParentID | Title | Message | Trigger |
|----|----------|-------|---------|---------|
| 1  | root     | Soporte Técnico | ¿En qué podemos ayudarte con el soporte? | 1 |
| 1_1| 1        | Internet | Por favor dinos tu proveedor: | 1 |
| 1_2| 1        | Telefonía | El soporte de telefonía está disponible de 9 a 18h. | 2 |
| 1_1_A| 1_1    | Fibra Óptica | Has seleccionado Fibra Óptica. Un agente te contactará. | 1 |


   ─────────┬────────────────────────────────────────────────────────────────┬──────────────────────────────────────────────┐
  │ Columna │ Propósito                                                      │ Ejemplo                                      │
  ├─────────┼────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────┤
  │ Title   │ Lo que aparece en la lista de opciones.                        │ "Soporte Técnico"                            │
  │ Message │ Lo que el bot dice después de que el usuario elige esa opción. │ "¿Qué tipo de falla tienes con tu servicio?" │
  └─────────┴────────────────────────────────────────────────────────────────┴──────────────────────────────────────────────┘

  
  ┌──────┬──────────┬─────────────────┬────────────────────────────────────────────────┬─────────┐
  │ ID   │ ParentID │ Title           │ Message                                        │ Trigger │
  ├──────┼──────────┼─────────────────┼────────────────────────────────────────────────┼─────────┤
  │ root │ none     │ Inicio          │ Bienvenido a Service Tandil. Elige una opción: │ 0       │
  │ 1    │ root     │ Soporte Técnico │ ¿Qué problema tienes?                          │ 1       │
  │ 2    │ root     │ Ventas          │ Consulta nuestros planes:                      │ 2       │
  └──────┴──────────┴─────────────────┴────────────────────────────────────────────────┴─────────┘
  El bot responderá automáticamente así:

  > Bienvenido a Service Tandil. Elige una opción:
  > 
  > 1. Soporte Técnico
  > 2. Ventas
  > 
  > ---
  > 0. Menú Principal


  En resumen: Title es la etiqueta de la opción y Message es el contenido o la pregunta que sigue.




## Requisitos

- Node.js v16+
- Cuenta de Servicio de Google (Service Account) con acceso a la Google Sheets API.
- Archivo `credentials.json` en la raíz del proyecto.

## Instalación

1. Clonar el repositorio.
2. Ejecutar `npm install`.
3. Copiar `.env.example` a `.env` y completar con tu `SPREADSHEET_ID`. Compartir con : sheets-for-whatsapp-test@gen-lang-client-0729884159.iam.gserviceaccount.com
4.  `credentials.json` esta como variable de entorno.

## Ejecución

```bash
node src/app.js
```

Escanea el código QR que aparecerá en la terminal con tu WhatsApp.

## Arquitectura

- **src/services/googleSheetsService.js**: Maneja la conexión con Google Sheets y el caché local.
- **src/services/stateService.js**: Gestiona el estado (posición en el menú) de cada usuario.
- **src/controllers/menuController.js**: Lógica de navegación y ruteo de mensajes.
- **src/app.js**: Punto de entrada, configuración de Baileys y listener de mensajes.
