update : ​Si vous ouvrez l'application officielle et que cela "casse" la session de votre pont, votre application Node.js ne plantera plus.
​Voici ce qui se passera dans le pire des cas :
​Vous demandez à Google d'allumer la clim.
​Mitsubishi rejette la demande (car l'application officielle a annulé le cookie).
​Google vous dit "Désolé, je ne peux pas joindre l'appareil".
​La réparation prend 2 secondes : Vous ouvrez simplement votre application Android Melhome (votre appli customisée). Elle va s'authentifier, récupérer un nouveau cookie tout neuf, et l'envoyer silencieusement à votre serveur Render.
​Vous redemandez à Google d'allumer la clim, et ça marche instantanément.
​Zéro réassociation Google Home. Zéro code à retaper. Zéro serveur qui crashe.