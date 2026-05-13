// Cloudflare Worker - Test

export default {
    async fetch(request, env) {
        return new Response('Hello World!', {
            headers: { 'Content-Type': 'text/plain' }
        });
    }
};