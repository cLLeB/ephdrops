/**
 * Themed Wordlist for Verbal Join Codes
 * Categories: Nature, Animals, Colors, Objects, Food, Actions, Time, People
 * 
 * 256 words × 4 positions = 4 billion combinations (32 bits entropy)
 * Enough for verbal security with rate limiting
 */

const WORDLIST = [
    // Categories for Verbal Join Codes
    // Nature & Environment
    'air', 'bay', 'beach', 'bird', 'bush', 'cave', 'clay', 'cliff',
    'cloud', 'coast', 'desert', 'dust', 'earth', 'field', 'fire', 'flood',
    'flower', 'forest', 'grass', 'hill', 'ice', 'island', 'lake', 'leaf',
    'moon', 'mountain', 'ocean', 'path', 'rain', 'river', 'rock', 'sand',

    // Animals & Creatures
    'ant', 'bear', 'bee', 'cat', 'cow', 'crab', 'deer', 'dog',
    'duck', 'eagle', 'fish', 'fly', 'frog', 'goat', 'goose', 'hawk',
    'horse', 'lamb', 'lion', 'mouse', 'owl', 'pig', 'rabbit', 'rat',
    'seal', 'shark', 'sheep', 'snake', 'spider', 'swan', 'tiger', 'wolf',

    // Colors & Shapes
    'black', 'blue', 'brown', 'gold', 'gray', 'green', 'orange', 'pink',
    'purple', 'red', 'silver', 'white', 'yellow', 'circle', 'square', 'star',
    'bright', 'dark', 'clear', 'round', 'flat', 'sharp', 'soft', 'hard',
    'long', 'short', 'thick', 'thin', 'wide', 'narrow', 'deep', 'high',

    // Daily Objects
    'bag', 'ball', 'bell', 'belt', 'boat', 'book', 'box', 'can',
    'cap', 'card', 'case', 'chair', 'clock', 'coat', 'cup', 'desk',
    'door', 'fork', 'glass', 'hat', 'key', 'knife', 'lamp', 'lock',
    'pen', 'phone', 'plate', 'ring', 'shoe', 'soap', 'spoon', 'watch',

    // Food & Drink
    'apple', 'bread', 'cake', 'cheese', 'corn', 'egg', 'fruit', 'grape',
    'honey', 'juice', 'bean', 'lemon', 'meat', 'milk', 'nut', 'onion',
    'pear', 'pie', 'plum', 'pork', 'rice', 'salt', 'soup', 'sugar',
    'tea', 'toast', 'water', 'wheat', 'wine', 'meal', 'snack', 'treat',

    // Common Actions
    'bring', 'build', 'call', 'catch', 'clean', 'come', 'dance', 'draw',
    'drink', 'drive', 'eat', 'fall', 'find', 'give', 'go', 'help',
    'hold', 'jump', 'keep', 'know', 'laugh', 'look', 'make', 'play',
    'read', 'run', 'say', 'sing', 'sit', 'sleep', 'smile', 'swim',

    // Time & Place
    'after', 'again', 'back', 'before', 'below', 'city', 'close', 'day',
    'early', 'east', 'end', 'farm', 'far', 'front', 'home', 'left',
    'main', 'near', 'night', 'north', 'now', 'once', 'open', 'out',
    'past', 'place', 'right', 'side', 'south', 'town', 'west', 'year',

    // People & Feelings
    'boy', 'child', 'dad', 'dear', 'face', 'family', 'friend', 'girl',
    'glad', 'good', 'hand', 'happy', 'head', 'kind', 'life', 'love',
    'man', 'mom', 'name', 'nice', 'old', 'own', 'proud', 'quiet',
    'real', 'safe', 'small', 'smart', 'son', 'true', 'woman', 'young'
];

// Ensure exactly 256 words for clean bit alignment
if (WORDLIST.length !== 256) {
    throw new Error(`Wordlist must have exactly 256 words, got ${WORDLIST.length}`);
}

module.exports = { WORDLIST };
