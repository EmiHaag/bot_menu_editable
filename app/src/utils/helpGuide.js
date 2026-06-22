const helpGuideCSS = `
                        /* Help Sidebar */
                        .help-toggle {
                            position: fixed;
                            left: 0;
                            top: 50%;
                            transform: translateY(-50%);
                            background: var(--primary-color);
                            color: white;
                            border: none;
                            border-radius: 0 8px 8px 0;
                            padding: 12px 8px;
                            cursor: pointer;
                            font-size: 14px;
                            writing-mode: vertical-lr;
                            text-orientation: mixed;
                            letter-spacing: 2px;
                            font-weight: 600;
                            z-index: 90;
                            transition: left 0.3s ease;
                            box-shadow: 2px 2px 8px rgba(0,0,0,0.15);
                        }
                        .help-toggle:hover { background: var(--primary-hover); }
                        .help-toggle.open { left: 360px; }
                        .help-search {
                            width: 100%;
                            padding: 10px 12px;
                            border: 2px solid var(--border-color);
                            border-radius: 8px;
                            font-size: 14px;
                            margin-bottom: 15px;
                            box-sizing: border-box;
                            background: var(--bg-box);
                            color: var(--text-main);
                            transition: border-color 0.2s;
                        }
                        .help-search:focus {
                            outline: none;
                            border-color: var(--primary-color);
                        }
                        .help-search::placeholder { color: #aaa; }
                        .help-no-results {
                            text-align: center;
                            color: var(--text-muted);
                            font-size: 14px;
                            padding: 30px 0;
                            display: none;
                        }
                        .help-sidebar {
                            position: fixed;
                            left: -360px;
                            top: 0;
                            width: 360px;
                            height: 100%;
                            background: var(--bg-white);
                            border-right: 2px solid var(--border-color);
                            z-index: 89;
                            overflow-y: auto;
                            transition: left 0.3s ease;
                            box-shadow: 4px 0 12px rgba(0,0,0,0.08);
                            padding: 20px;
                            box-sizing: border-box;
                        }
                        .help-sidebar.open { left: 0; }
                        .help-sidebar h3 { 
                            color: var(--primary-color); 
                            margin: 0 0 5px 0; 
                            font-size: 18px;
                            display: flex;
                            align-items: center;
                            gap: 10px;
                        }
                        .help-sidebar .subtitle {
                            color: var(--text-muted);
                            font-size: 13px;
                            margin-bottom: 25px;
                            padding-bottom: 15px;
                            border-bottom: 2px solid var(--border-color);
                        }
                        .help-section {
                            margin-bottom: 20px;
                            background: var(--bg-box);
                            border-radius: 8px;
                            border: 1px solid var(--border-color);
                            overflow: hidden;
                        }
                        .help-section summary {
                            padding: 12px 15px;
                            cursor: pointer;
                            font-weight: 600;
                            font-size: 14px;
                            color: var(--text-main);
                            background: var(--bg-white);
                            border-bottom: 1px solid transparent;
                            user-select: none;
                        }
                        .help-section[open] summary {
                            border-bottom-color: var(--border-color);
                        }
                        .help-section summary:hover { background: #f5f5f5; }
                        .help-section .content {
                            padding: 12px 15px;
                            font-size: 13px;
                            line-height: 1.6;
                            color: #444;
                        }
                        .help-section .content p { margin: 6px 0; }
                        .help-section .content code {
                            background: #e8f5e9;
                            color: #2e7d32;
                            padding: 2px 6px;
                            border-radius: 3px;
                            font-size: 12px;
                        }
                        .help-section .content .tag {
                            display: inline-block;
                            background: #fff3cd;
                            color: #856404;
                            padding: 1px 6px;
                            border-radius: 3px;
                            font-size: 12px;
                            font-weight: 600;
                        }
                        .help-section .content .step {
                            display: flex;
                            gap: 10px;
                            margin: 10px 0;
                            padding: 10px;
                            background: white;
                            border-radius: 6px;
                            border: 1px solid var(--border-color);
                        }
                        .help-section .content .step-num {
                            background: var(--primary-color);
                            color: white;
                            width: 22px;
                            height: 22px;
                            border-radius: 50%;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            font-size: 12px;
                            font-weight: 700;
                            flex-shrink: 0;
                        }
                        .help-section .content .step-text { flex: 1; }
                        .help-section .content .step-text strong { display: block; margin-bottom: 3px; }
                        .help-section .content .example {
                            background: #f8f9fa;
                            border-left: 3px solid var(--primary-color);
                            padding: 10px 12px;
                            margin: 8px 0;
                            border-radius: 0 6px 6px 0;
                            font-size: 12px;
                        }
                        .help-section .content .example strong { color: var(--primary-color); }`;

const helpGuideHTML = `
                    <!-- Help Sidebar -->
                    <button class="help-toggle" id="helpToggle" onclick="toggleHelp()">📖 GUÍA</button>
                    <div class="help-sidebar" id="helpSidebar">
                        <h3>📖 Guía del Editor</h3>
                        <div class="subtitle">Aprendé a crear el menú de tu bot paso a paso</div>

                        <input type="text" class="help-search" id="helpSearch" placeholder="🔍 Buscar en la guía...">

                        <div class="help-no-results" id="helpNoResults">😕 No encontré nada con ese término</div>

                        <details class="help-section">
                            <summary>🔤 ¿Qué es cada columna de la tabla?</summary>
                            <div class="content">
                                <p><strong>Disparador</strong> — El número o letra que el usuario escribe para elegir esta opción (ej: <code>1</code>, <code>2</code>, <code>3</code>).</p>
                                <p><strong>Título</strong> — El texto que ve el usuario en el menú (ej: <code>Hamburguesa</code>).</p>
                                <p><strong>Mensaje</strong> — Lo que responde el bot cuando el usuario elige esta opción.</p>
                                <p><strong>Precio</strong> — Opcional. Si lo ponés, se muestra al lado del título (ej: <code>$1500</code>).</p>
                                <p><strong>Carrito de compras</strong> — Grupo de checkboxes que activan comportamientos especiales: <span class="tag">✅ Pedido</span> <span class="tag">🔢 Cantidad</span> <span class="tag">🏁 Finalizar</span> <span class="tag">📝 Datos</span> <span class="tag">📎 Archivo</span> <span class="tag">💳 Pagar</span>.</p>
                            </div>
                        </details>

                        <details class="help-section">
                            <summary>🌳 ¿Cómo crear submenús?</summary>
                            <div class="content">
                                <p>Un submenú es una opción que lleva a más opciones. Por ejemplo: "Bebidas" → "Coca", "Sprite", "Agua".</p>
                                <div class="step">
                                    <div class="step-num">1</div>
                                    <div class="step-text">
                                        <strong>Creá la opción principal</strong>
                                        En la tabla, buscá el nodo <strong>Raíz</strong> y hacé clic en <strong>+ Hijo</strong>.
                                    </div>
                                </div>
                                <div class="step">
                                    <div class="step-num">2</div>
                                    <div class="step-text">
                                        <strong>Completá los datos</strong>
                                        Poné un disparador (ej: <code>3</code>), un título (ej: <code>Bebidas</code>), y en el mensaje poné algo como <em>"Elegí tu bebida:"</em>.<br>
                                        <small>✏️ Este mensaje se muestra cuando el usuario elige "Bebidas".</small>
                                    </div>
                                </div>
                                <div class="step">
                                    <div class="step-num">3</div>
                                    <div class="step-text">
                                        <strong>Agregale hijos</strong>
                                        En la tabla, buscá el nodo "Bebidas" que creaste y hacé clic en <strong>"+ Hijo"</strong> para agregar "Coca", "Sprite", etc.
                                    </div>
                                </div>
                                <div class="example">
                                    💡 <strong>Tip:</strong> Si un nodo tiene hijos, al elegirlo se muestran los hijos como opciones. Si no tiene hijos, se muestra el mensaje final.
                                </div>
                            </div>
                        </details>

                        <details class="help-section">
                            <summary>📝 ¿Cómo pedir datos al usuario (nombre, dirección)?</summary>
                            <div class="content">
                                <p>El bot puede pedirle al usuario que escriba texto libre (como su nombre o dirección).</p>
                                <div class="step">
                                    <div class="step-num">1</div>
                                    <div class="step-text">
                                        <strong>Creá un nodo y activá "Capturar dato"</strong>
                                        Editá o creá un nodo y marcá el checkbox <strong>"Capturar dato y continuar"</strong> (color naranja).
                                    </div>
                                </div>
                                <div class="step">
                                    <div class="step-num">2</div>
                                    <div class="step-text">
                                        <strong>Escribí el mensaje de pregunta</strong>
                                        En el campo Mensaje poné la pregunta, ej: <em>"¿Cuál es tu nombre?"</em>
                                    </div>
                                </div>
                                <div class="step">
                                    <div class="step-num">3</div>
                                    <div class="step-text">
                                        <strong>Agregá un hijo para el siguiente paso</strong>
                                        Si querés pedir más datos después (ej: primero nombre, luego dirección), agregale un hijo al nodo con "Capturar dato". Ese hijo también debe tener el tag activado.
                                    </div>
                                </div>
                                <div class="example">
                                    💡 <strong>Ejemplo:</strong> "Nombre" (📝) → "Dirección" (📝) → "Confirmar" (🏁)
                                </div>
                            </div>
                        </details>

                        <details class="help-section">
                            <summary>📎 ¿Cómo pedir un archivo o foto?</summary>
                            <div class="content">
                                <p>El bot puede recibir imágenes o PDFs del usuario, como comprobantes o recetas.</p>
                                <div class="step">
                                    <div class="step-num">1</div>
                                    <div class="step-text">
                                        <strong>Creá un nodo y activá "Solicitar archivo"</strong>
                                        Editá o creá un nodo y marcá el checkbox <strong>"Solicitar archivo"</strong> (color verde).
                                    </div>
                                </div>
                                <div class="step">
                                    <div class="step-num">2</div>
                                    <div class="step-text">
                                        <strong>Escribí el mensaje de pedido</strong>
                                        Ej: <em>"Envianos la foto de tu receta médica"</em>
                                    </div>
                                </div>
                                <div class="step">
                                    <div class="step-num">3</div>
                                    <div class="step-text">
                                        <strong>Agregá un hijo para después del archivo</strong>
                                        Si querés que después del archivo haya otro paso (ej: mostrar "Gracias"), agregale un hijo con el mensaje final. Si no, el bot confirma y vuelve al inicio.
                                    </div>
                                </div>
                                <div class="example">
                                    📎 <strong>Tip:</strong> El usuario puede enviar el archivo con o sin comentario. El comentario también se recibe.
                                </div>
                            </div>
                        </details>

                        <details class="help-section">
                            <summary>🛒 ¿Cómo crear un menú de pedidos?</summary>
                            <div class="content">
                                <p>Podés armar un carrito de compras donde el usuario va agregando productos.</p>
                                <div class="step">
                                    <div class="step-num">1</div>
                                    <div class="step-text">
                                        <strong>Activá "Crear pedido" en los productos</strong>
                                        Editá cada producto y marcá <strong>"Crear pedido"</strong> (color amarillo). Así se agregan al carrito.
                                    </div>
                                </div>
                                <div class="step">
                                    <div class="step-num">2</div>
                                    <div class="step-text">
                                        <strong>Opcional: activá "Pedir cantidad"</strong>
                                        Si querés que el usuario elija cuántas unidades, marcá también <strong>"Pedir cantidad"</strong> (color celeste). El bot va a preguntar "¿Cuántos?".
                                    </div>
                                </div>
                                <div class="step">
                                    <div class="step-num">3</div>
                                    <div class="step-text">
                                        <strong>Variantes (opcional)</strong>
                                        Si un producto tiene talles (chica/grande), agregale hijos. En el campo Mensaje de cada hijo escribí <strong>##COMPLETAR##</strong> manualmente (no tiene checkbox). Cuando el usuario ingresa la cantidad, el bot muestra las variantes y al elegir una agrega <em>"2 x pepperoni (chica)"</em> al carrito.
                                    </div>
                                </div>
                                <div class="step">
                                    <div class="step-num">4</div>
                                    <div class="step-text">
                                        <strong>Opcional: activá "Ir a pagar"</strong>
                                        En el nodo raíz o categoría, marcá <strong>"Ir a pagar"</strong> (color verde). Cuando haya items, el menú muestra <code>*p*. Ir a pagar</code>. Al escribir <code>p</code>, va al primer hijo con "Finalizar".
                                    </div>
                                </div>
                                <div class="step">
                                    <div class="step-num">5</div>
                                    <div class="step-text">
                                        <strong>Creá un nodo "Finalizar"</strong>
                                        Agregá un hijo con el tag <strong>"Finalizar"</strong> (color violeta). El mensaje podría ser <em>"Gracias por tu pedido"</em>. El bot mostrará el resumen con el total antes de finalizar.
                                    </div>
                                </div>
                                <div class="example">
                                    🛍️ <strong>Ejemplo:</strong><br>
                                    Menú Principal (💳) → 1. Hamburguesa (✅🔢) → 2. Pizza (✅🔢) → 3. Finalizar (🏁)<br>
                                    El usuario puede escribir <code>vaciar</code> para limpiar el carrito, y <code>p</code> si está habilitado "Ir a pagar".
                                </div>
                            </div>
                        </details>

                        <details class="help-section">
                            <summary>🎮 ¿Cómo funciona el bot?</summary>
                            <div class="content">
                                <div class="step">
                                    <div class="step-num">1</div>
                                    <div class="step-text">
                                        <strong>El usuario escribe algo</strong>
                                        Si es un número/letra de una opción, el bot muestra su mensaje.
                                    </div>
                                </div>
                                <div class="step">
                                    <div class="step-num">2</div>
                                    <div class="step-text">
                                        <strong>Comandos globales</strong>
                                        El usuario siempre puede escribir:
                                        <code>0</code> — Volver al inicio<br>
                                        <code>v</code> — Volver atrás<br>
                                        <code>vaciar</code> — Vaciar el carrito
                                    </div>
                                </div>
                                <div class="step">
                                    <div class="step-num">3</div>
                                    <div class="step-text">
                                        <strong>Tags especiales</strong>
                                        Los tags modifican el comportamiento:
                                        <span class="tag">##PEDIDO##</span> Agrega al carrito<br>
                                        <span class="tag">##CANTIDAD##</span> Pregunta cuántos<br>
                                        <span class="tag">##DATOS##</span> Espera texto del usuario<br>
                                        <span class="tag">##ARCHIVO##</span> Espera archivo/imagen<br>
                                        <span class="tag">##FINALIZAR##</span> Finaliza el pedido (combinable)<br>
                                        <span class="tag">##COMPLETAR##</span> Completa item con variante<br>
                                        <span class="tag">##PAGAR##</span> Muestra opción "Ir a pagar" (combinable)
                                    </div>
                                </div>
                                <div class="step">
                                    <div class="step-num">4</div>
                                    <div class="step-text">
                                        <strong>Comandos del usuario</strong>
                                        <code>0</code> — Volver al inicio<br>
                                        <code>v</code> — Volver atrás<br>
                                        <code>vaciar</code> — Vaciar carrito<br>
                                        <code>p</code> — Ir a pagar (si está habilitado)
                                    </div>
                                </div>
                            </div>
                        </details>
                    </div>`;

const helpGuideJS = `
                        function toggleHelp() {
                            const sidebar = document.getElementById('helpSidebar');
                            const toggle = document.getElementById('helpToggle');
                            sidebar.classList.toggle('open');
                            toggle.classList.toggle('open');
                            if (sidebar.classList.contains('open')) {
                                setTimeout(() => document.getElementById('helpSearch').focus(), 300);
                            }
                        }

                        function filterHelp(query) {
                            const sections = document.querySelectorAll('.help-section');
                            const noResults = document.getElementById('helpNoResults');
                            if (!sections.length || !noResults) return;
                            const q = query.toLowerCase().trim();
                            if (!q) {
                                sections.forEach(s => { s.style.display = ''; });
                                noResults.style.display = 'none';
                                return;
                            }
                            const words = q.split(/\s+/).filter(w => w.length > 1);
                            const scored = [];
                            sections.forEach(section => {
                                const text = (section.textContent || '').toLowerCase();
                                let matchCount = 0;
                                words.forEach(w => {
                                    if (text.includes(w)) matchCount++;
                                });
                                if (matchCount > 0) {
                                    section.style.display = '';
                                    scored.push({ section, score: matchCount });
                                } else {
                                    section.style.display = 'none';
                                }
                            });
                            scored.sort((a, b) => b.score - a.score);
                            const parent = sections[0].parentNode;
                            if (parent) {
                                scored.forEach(item => parent.appendChild(item.section));
                            }
                            noResults.style.display = scored.length === 0 ? 'block' : 'none';
                        }

                        document.getElementById('helpSearch')?.addEventListener('input', function() { filterHelp(this.value); });`;

module.exports = { helpGuideCSS, helpGuideHTML, helpGuideJS };
