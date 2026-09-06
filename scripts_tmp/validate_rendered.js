const fs = require('fs');
const html = fs.readFileSync('C:/Users/emili/AppData/Local/Temp/opencode/dashboard_render.html', 'utf8');
const re = /<script>([\s\S]*?)<\/script>/g;
let m, i = 0;
while ((m = re.exec(html)) !== null) {
    i++;
    try {
        new Function(m[1]);
        console.log('SCRIPT ' + i + ' OK (' + m[1].length + ' chars)');
    } catch (e) {
        console.log('SCRIPT ' + i + ' SYNTAX ERROR: ' + e.message);
        const L = m[1].split('\n');
        console.log('  total lines:', L.length);
    }
}