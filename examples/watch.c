// Watchpoint debuggee: a loop that writes a global and a struct field at known
// lines, so a data breakpoint's stop line can be asserted.
#include <stdio.h>

struct Counter {
    int hits;
    int last;
};

int g_total = 0;
struct Counter counter = {0, 0};

int main(void) {
    int local = 0;
    for (int i = 1; i <= 3; i++) {
        local += i;
        g_total += i;            // line 17: writes g_total
        counter.last = i;        // line 18: writes counter.last
        counter.hits++;          // line 19: writes counter.hits
    }
    printf("total=%d hits=%d local=%d\n", g_total, counter.hits, local);
    return 0;
}
