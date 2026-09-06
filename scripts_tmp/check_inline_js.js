const fs = require('fs');
const src = fs.readFileSync('C:/Users/emili/coding/bots_koyeb/bot_menu/app/src/utils/dashboard.js', 'utf8');
const lines = src.split('\n');

// Reemplaza SOLO interpolaciones reales ${...} (con llaves balanceadas)
function stripInterpolations(s) {
    let out = '', i = 0;
    while (i < s.length) {
        if (s[i] === '$' && s[i + 1] === '{') {
            let depth = 1, j = i + 2;
            while (j < s.length && depth > 0) {
                if (s[j] === '{') depth++;
                else if (s[j] === '}') depth--;
                j++;
            }
            out += '0';
            i = j;
        } else {
            out += s[i];
            i++;
        }
    }
    return out;
}

for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '<script>') {
        let end = -1;
        for (let j = i + 1; j < lines.length; j++) {
            if (lines[j].trim() === '</script>') { end = j; break; }
        }
        if (end !== -1) {
            const body = stripInterpolations(lines.slice(i + 1, end).join('\n'));
            try {
                new Function(body);
                console.log('SCRIPT OK', body.length + ' chars (lineas ' + (i + 2) + '-' + end + ')');
            } catch (e) {
                console.log('SYNTAX ERROR desde linea dashboard ' + (i + 2) + ': ' + e.message);
                process.exit(1);
            }
        }
    }
}