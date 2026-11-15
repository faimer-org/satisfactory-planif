# Conventions d'interface

- Interface entièrement en français, nombres au format français (virgule décimale).
- Thème sombre unique via les variables CSS de `:root` (`color-scheme: dark`), indépendant de la préférence du système. Accent rouille (survol, sélection) ; jaune `--star` pour les recettes alternatives.
- Ombres de profondeur `--sh-1`, `--sh-2`, `--sh-btn`, `--sh-in`.
- Saisie des débits : virgule (le point est converti), une seule virgule, 2 décimales max, 100 000 max ; un champ vidé reprend une valeur au blur. Temps : minutes + secondes entières, 2 h max.
- Arbres de fabrication (onglet Arbres, détail d'une étape) : seul le premier niveau sous la pièce est déplié, la suite se charge au dépliage. L'état ouvert ou fermé de chaque nœud est gardé en mémoire (`treeOpen`, clé « portée|chemin » : `data-s` + `data-p`), pas dans `localStorage`, pour survivre aux re-rendus de `updateResults` ; il est perdu au rechargement. Mise en page d'un nœud : le triangle est un `::before` du `summary` (flex), jamais seul sur sa ligne ; les groupes `.nh` (icône, quantité, nom) et `.mk` (icône et nombre de machines) ne se coupent pas entre icône et texte. Une feuille (`.leaf`) réserve la place du triangle (retrait de 26 px) : les entrées d'une même recette sont alignées, dépliables ou non.
- Composants maison : infobulles interactives (`#tip`), menu de recettes (`#rmenu`), réglage d'extraction (`#xmenu`, boutons à bascule sous une carte de « Ressources à amener » ; Échap, clic extérieur ou défilement hors écran le ferment), sélecteur de pièce (`#ipick`), toast, modale (`#modal`, Entrée dans un champ = bouton d'action).

## Usines

- Jusqu'à 5 usines (`MAX_FACTORIES`), dont une active : Mon usine, Transport (« Ressources de Mon usine ») et le lien de partage travaillent sur elle. Chaque usine a ses pièces, ses recettes choisies, ses réglages d'extraction et ses choix de transport (`via`).
- Nom par défaut : le plus petit nombre libre (« 1 », « 2 »…) ; 30 caractères au plus, unique sans tenir compte de la casse. Dans les messages : « l'usine 2 », « l'usine « Nord » » (`fLabel`).
- Mon usine : une rangée de boutons (une usine chacun, avec son nombre de pièces) et un « + » pour en créer une (fenêtre de nom). À 5 usines, le « + » est grisé avec `aria-disabled` (pas `disabled`, pour garder l'infobulle) ; un clic affiche l'explication en toast, utile au tactile. À droite des boutons, dans cet ordre : « Renommer », « Vider l'usine » (si elle a des pièces) et « Supprimer l'usine » (couleurs du bouton choisi de « Pour 1 pièce / Pour 1 machine/min »), qui agissent sur l'usine active. « Supprimer l'usine » demande confirmation ; « Vider l'usine » (confirmation) retire ses pièces, recettes et réglages d'extraction, l'usine reste. Les usines vides comptent dans la limite.
- « + Ajouter à mon usine » (fiche pièce) et le « + » du catalogue ouvrent la même fenêtre : débit pré-rempli à 1/min (« Pour 1 pièce ») ou au débit d'une machine en recette standard (« Pour 1 machine/min »), puis l'usine de destination (active par défaut) ou « + Nouvelle usine » avec son nom. Sans aucune usine, pas de choix : l'usine « 1 » est créée. Si la pièce est déjà dans l'usine choisie, son débit augmente d'autant (message sous le champ). L'usine choisie devient l'usine active. Le « + Ajouter une pièce » de Mon usine ajoute 1/min à l'usine active, sans fenêtre.
- Transport, « Ressources de Mon usine » : les mêmes boutons (sans « + ») choisissent l'usine active ; en « Saisie libre », les choix de transport restent ceux de `sp-transport`.

## État local (`localStorage`)

`sp-factories` (`{ cur, list: [{ id, name, goals: [{c, rate}], choices, ext, via }] }` ; `ext` : ressource → `{m, p}` ; `via` : ressource → `belt` | `train` | `drone`), `sp-sel`, `sp-view`, `sp-tab-i`, `sp-tab-f`, `sp-qmode`, `sp-transport` (réglages de Transport ; son `via` sert à la saisie libre).

Anciennes clés, lues une seule fois quand `sp-factories` n'existe pas encore, puis plus jamais écrites : `sp-factory`, `sp-choice-f` (ou `sp-choice`), `sp-extract` et le `via` de `sp-transport` deviennent l'usine « 1 » (rien n'est créé si l'ancienne usine était vide). Toute nouvelle clé s'ajoute ici.

## Ancres

`#usine`, `#transport`, `#desc-ironplate-c` (fiche), `#usine:…` (usine partagée, voir [partage-url.md](partage-url.md)).
