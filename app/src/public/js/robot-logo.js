function drawRobot(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Set base coordinates based on canvas size
    // We assume the drawing is designed for a ~400x400 space and we scale it
    const scale = Math.min(canvas.width, canvas.height) / 400;
    
    ctx.save();
    ctx.scale(scale, scale);
    
    // Drawing at center of 400x400 space
    const centerX = 200;
    const centerY = 220;

    // --- ANTENA ---
    ctx.beginPath();
    ctx.moveTo(centerX, centerY - 120);
    ctx.lineTo(centerX, centerY - 150);
    ctx.strokeStyle = '#25D366';
    ctx.lineWidth = 6;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(centerX, centerY - 155, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#25D366';
    ctx.fill();

    // --- CUERPO (Base) ---
    ctx.beginPath();
    ctx.roundRect(centerX - 60, centerY - 20, 120, 100, 20);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#25D366';
    ctx.lineWidth = 5;
    ctx.stroke();

    // Pantalla del pecho (WA 24/7)
    ctx.beginPath();
    ctx.roundRect(centerX - 40, centerY + 10, 80, 50, 10);
    ctx.fillStyle = '#075E54';
    ctx.fill();
    
    ctx.fillStyle = '#25D366';
    ctx.font = 'bold 14px Arial';
    ctx.textAlign = 'center';
    ctx.fillText("WA", centerX, centerY + 30);
    ctx.font = '10px Arial';
    ctx.fillText("24/7", centerX, centerY + 50);

    // --- CABEZA ---
    ctx.beginPath();
    ctx.roundRect(centerX - 80, centerY - 120, 160, 110, 40);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#25D366';
    ctx.stroke();

    // Cara (visor oscuro)
    ctx.beginPath();
    ctx.roundRect(centerX - 65, centerY - 105, 130, 80, 30);
    ctx.fillStyle = '#128C7E';
    ctx.fill();

    // Ojos (Brillantes)
    ctx.beginPath();
    ctx.arc(centerX - 30, centerY - 65, 12, 0, Math.PI * 2);
    ctx.arc(centerX + 30, centerY - 65, 12, 0, Math.PI * 2);
    ctx.fillStyle = '#25D366';
    ctx.fill();

    // Sonrisa
    ctx.beginPath();
    ctx.arc(centerX, centerY - 60, 20, 0.2 * Math.PI, 0.8 * Math.PI);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.stroke();

    // --- BRAZOS ---
    ctx.lineWidth = 15;
    ctx.lineCap = 'round';
    
    // Brazo izquierdo (saludando)
    ctx.beginPath();
    ctx.moveTo(centerX - 60, centerY + 10);
    ctx.quadraticCurveTo(centerX - 110, centerY, centerX - 100, centerY - 50);
    ctx.strokeStyle = '#25D366';
    ctx.stroke();

    // Brazo derecho
    ctx.beginPath();
    ctx.moveTo(centerX + 60, centerY + 10);
    ctx.lineTo(centerX + 100, centerY + 40);
    ctx.stroke();
    
    ctx.restore();
}
