import { redirect, Resolver } from '../resolver';

export function googleSearch(query: string) {
    return redirect(`https://www.google.co.uk/search?q=${encodeURIComponent(query)}`);
}

// Last in the chain: matches everything.
export const googleResolver: Resolver<string> = {
    name: 'google',
    match: (path) => path,
    resolve: async (path) => {
        if (path === '') {
            console.log('Defaulting to Google');
            return redirect('https://www.google.co.uk', 'max-age=600');
        }
        console.log(`Bailing out: ${path}`);
        return googleSearch(path);
    },
};
