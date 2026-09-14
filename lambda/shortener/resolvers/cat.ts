import { redirect, Resolver } from '../resolver';

// nakom.is/cat404 → https://http.cat/status/404
export const catResolver: Resolver<string> = {
    name: 'cat',
    match: (path) => (path.startsWith('cat') && path.length > 3 ? path.slice(3) : null),
    resolve: async (status) => {
        console.log(`Redirecting to cat: ${status}`);
        return redirect(`https://http.cat/status/${status}`);
    },
};
