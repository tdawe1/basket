export type Category = {
  id: string;
  label: string;
  emoji: string;
};

export const CATEGORIES: Category[] = [
  { id: "fruit-veg", label: "Fruit & veg", emoji: "🥬" },
  { id: "bakery", label: "Bakery", emoji: "🍞" },
  { id: "meat-fish", label: "Meat & fish", emoji: "🥩" },
  { id: "dairy", label: "Dairy & eggs", emoji: "🥛" },
  { id: "chilled", label: "Chilled", emoji: "🧀" },
  { id: "frozen", label: "Frozen", emoji: "🧊" },
  { id: "cupboard", label: "Cupboard", emoji: "🥫" },
  { id: "snacks", label: "Snacks", emoji: "🍪" },
  { id: "drinks", label: "Drinks", emoji: "☕" },
  { id: "household", label: "Household", emoji: "🧹" },
  { id: "toiletries", label: "Toiletries", emoji: "🧴" },
  { id: "baby", label: "Baby", emoji: "🍼" },
  { id: "pet", label: "Pet", emoji: "🐾" },
  { id: "other", label: "Other", emoji: "🛒" },
];

export const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));

const KEYWORDS: Record<string, string[]> = {
  "fruit-veg": [
    "banana", "apple", "orange", "spinach", "lettuce", "tomato", "potato",
    "onion", "garlic", "carrot", "broccoli", "avocado", "lemon", "lime",
    "pepper", "cucumber", "mushroom", "strawberr", "blueberr", "raspberr",
    "grape", "pear", "mango", "herb", "coriander", "cilantro", "basil",
    "salad", "celery", "courgette", "zucchini", "aubergine", "eggplant",
    "leek", "cabbage", "kale", "rocket", "arugula", "pineapple", "melon",
    "watermelon", "peach", "plum", "cherry", "cherries", "kiwi", "ginger",
    "chilli", "chili", "spring onion", "scallion", "beetroot", "beet",
    "sweet potato", "butternut", "squash", "corn", "sweetcorn",
    "バナナ", "りんご", "リンゴ", "みかん", "ほうれん草", "レタス", "トマト",
    "じゃがいも", "ジャガイモ", "玉ねぎ", "たまねぎ", "にんにく", "人参", "にんじん",
    "ブロッコリー", "アボカド", "レモン", "きゅうり", "キュウリ", "きのこ", "イチゴ",
    "ぶどう", "梨", "マンゴー", "大葉", "バジル", "キャベツ", "白菜", "ネギ",
    "なす", "ナス", "ピーマン", "かぼちゃ", "さつまいも", "生姜", "しょうが",
  ],
  bakery: [
    "bread", "bagel", "baguette", "croissant", "roll", "bap", "ciabatta",
    "sourdough", "tortilla", "wrap", "pitta", "pita", "naan", "crumpet",
    "muffin", "pastry", "brioche", "loaf",
    "パン", "食パン", "フランスパン", "クロワッサン", "bagel", "おにぎり",
  ],
  "meat-fish": [
    "chicken", "beef", "pork", "lamb", "mince", "steak", "sausage", "bacon",
    "ham", "turkey", "salmon", "tuna", "cod", "haddock", "prawn", "shrimp",
    "fish", "meat", "burger", "meatball", "chorizo", "salami",
    "鶏肉", "鶏", "牛肉", "豚肉", "ひき肉", "挽肉", "ステーキ", "ソーセージ",
    "ベーコン", "ハム", "サーモン", "鮭", "マグロ", "まぐろ", "エビ", "えび",
    "魚", "肉",
  ],
  dairy: [
    "milk", "butter", "cheese", "yogurt", "yoghurt", "cream", "egg", "eggs",
    "cheddar", "mozzarella", "parmesan", "feta", "cottage cheese", "sour cream",
    "creme fraiche", "crème fraîche", "oat milk", "almond milk", "soya milk",
    "soy milk",
    "牛乳", "ミルク", "バター", "チーズ", "ヨーグルト", "生クリーム", "卵",
    "たまご",
  ],
  chilled: [
    "hummus", "houmous", "pesto", "tofu", "tempeh", "guacamole", "dip",
    "coleslaw", "fresh pasta", "gnocchi", "pizza", "quiche", "olives",
    "豆腐", "納豆", "キムチ", "ハムカツ", "サラダチキン",
  ],
  frozen: [
    "frozen", "ice cream", "icecream", "peas", "chips", "fries", "nugget",
    "fish finger", "ice cube", "hash brown", "waffle",
    "冷凍", "アイス", "アイスクリーム",
  ],
  cupboard: [
    "rice", "pasta", "spaghetti", "noodle", "flour", "sugar", "salt", "oil",
    "olive oil", "vinegar", "sauce", "ketchup", "mustard", "mayo",
    "mayonnaise", "tin", "canned", "beans", "lentil", "chickpea", "stock",
    "broth", "spice", "peppercorn", "cereal", "oat", "porridge", "honey",
    "jam", "peanut butter", "nutella", "coconut milk", "passata", "tomato puree",
    "soy sauce", "worcester", "couscous", "quinoa", "breadcrumbs",
    "米", "白米", "ご飯", "パスタ", "うどん", "そば", "ラーメン", "小麦粉",
    "砂糖", "塩", "油", "醤油", "しょうゆ", "味噌", "みそ", "みりん", "酢",
    "缶詰", "豆", "はちみつ", "ジャム",
  ],
  snacks: [
    "crisp", "chip", "chocolate", "biscuit", "cookie", "cake", "popcorn",
    "nut", "almond", "cashew", "peanut", "bar", "sweet", "candy", "raisin",
    "お菓子", "チョコ", "チョコレート", "クッキー", "ポテチ", "スナック",
  ],
  drinks: [
    "coffee", "tea", "juice", "water", "sparkling", "soda", "cola", "beer",
    "wine", "milkshake", "squash", "cordial", "kombucha", "smoothie",
    "コーヒー", "紅茶", "お茶", "ジュース", "水", "ビール", "ワイン",
  ],
  household: [
    "bin bag", "trash bag", "foil", "cling film", "saran", "kitchen roll",
    "paper towel", "sponge", "washing up", "dish soap", "dishwasher",
    "laundry", "detergent", "fabric softener", "bleach", "cleaner", "wipes",
    "bin liner", "baking paper", "parchment", "sandwich bag", "battery",
    "light bulb", "candle",
    "ゴミ袋", "ラップ", "アルミホイル", "スポンジ", "洗剤", "柔軟剤", "電池",
  ],
  toiletries: [
    "toothpaste", "toothbrush", "shampoo", "conditioner", "soap", "shower gel",
    "deodorant", "razor", "shaving", "toilet roll", "toilet paper", "tissue",
    "plaster", "band-aid", "paracetamol", "ibuprofen", "suncream", "sunscreen",
    "moisturiser", "moisturizer", "lotion", "cotton",
    "歯磨き粉", "歯ブラシ", "シャンプー", "リンス", "石鹸", "せっけん",
    "デオドラント", "トイレットペーパー", "ティッシュ",
  ],
  baby: [
    "nappy", "diaper", "wipe", "formula", "baby food", "dummy",
    "pacifier",
    "おむつ", "オムツ", "粉ミルク", "ベビー",
  ],
  pet: [
    "cat food", "dog food", "litter", "treat", "pet", "kitty", "puppy",
    "キャットフード", "ドッグフード", "猫砂", "ペット",
  ],
};

export function guessCategory(name: string): string {
  const n = name.toLowerCase();
  for (const [id, words] of Object.entries(KEYWORDS)) {
    if (words.some((w) => n.includes(w))) return id;
  }
  return "other";
}

export function categoryById(id: string): Category {
  return CATEGORIES.find((c) => c.id === id) ?? CATEGORIES[CATEGORIES.length - 1];
}

export function prettyName(name: string): string {
  const t = name.trim();
  if (!t) return t;
  if (t === t.toLowerCase()) return t.charAt(0).toUpperCase() + t.slice(1);
  return t;
}

export function parseQuickAdd(raw: string): { name: string; quantity: string } {
  const t = raw.trim();
  let m = t.match(/^(\d+(?:[.,]\d+)?)\s*x\s+(.+)$/i);
  if (m) return { quantity: m[1], name: prettyName(m[2]) };
  m = t.match(/^(.+?)\s+x\s*(\d+(?:[.,]\d+)?)$/i);
  if (m) return { quantity: m[2], name: prettyName(m[1]) };
  return { quantity: "", name: prettyName(t) };
}

export const USER_COLORS = [
  "#2f6f4e",
  "#bc6c25",
  "#6d4aff",
  "#b42318",
  "#026aa2",
  "#c11574",
];
