const urls = [
    'https://lh3.googleusercontent.com/d/1N7FAf2kN60fncb8v35EgIpmqCucNZR4S',
    'https://lh3.googleusercontent.com/d/1st2Uf_mlivn0rk_dhaK_hMnX6iDKgK2b',
    'https://lh3.googleusercontent.com/d/1aIwrAudQIApwlG36wbMLZR5lHPtszBqO'
];
(async () => {
    for (const u of urls) {
        try {
            const r = await fetch(u, { method: 'GET', redirect: 'follow' });
            const ct = r.headers.get('content-type') || '';
            console.log(r.status, ct.split(';')[0], u.slice(0, 60));
        } catch (e) {
            console.log('ERROR', e.message, u.slice(0, 60));
        }
    }
    process.exit(0);
})();