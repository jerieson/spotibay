import dns from 'node:dns';
import net from 'node:net';

/**
 * Outbound connections try IPv4 first and give each address longer to answer. On hosts with a
 * broken IPv6 route (the VM), Node's default "happy eyeballs" gave up on IPv4 too after 250 ms
 * per address, so calls to MusicBrainz and others failed with ETIMEDOUT. Imported first.
 */
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamilyAttemptTimeout(2000);
